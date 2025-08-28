import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ref, onValue, set, update, get, remove, onDisconnect, off, runTransaction } from 'firebase/database'
import { db, ensureAuth } from './firebase'
import './room.css'
import { v4 as uuidv4 } from 'uuid'; // Import UUID library
const CARDS = ['0','1','2','3','5','8','13','21','34', '55','89','?','♾','☕']

// avatar havuzu (10 adet). İsterseniz emoji'leri değiştirin.
const AVATAR_POOL = ['🦊','🦄','🐝','🐙','🐯','🐼','🦁','🐵','🦉','🐸']

// basit hash(uid) -> sayı (deterministik, stabil seçim için)
function uidHash(s = '') {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i)
  return Math.abs(h)
}

function avatarFor(uid) {
  if (!uid) return AVATAR_POOL[0]
  return AVATAR_POOL[uidHash(uid) % AVATAR_POOL.length]
}

export default function Room({ roomId, name, onLeave }) {
  // LOTR karakterleri listesi — başlangıçta bunlardan birini atıyoruz
  const DEFAULT_NAMES = ['Frodo','Samwise','Gandalf','Aragorn','Legolas','Gimli','Boromir','Merry','Pippin','Elrond','Galadriel','Bilbo']

  // önce localStorage kontrol et, yoksa listeden rastgele al
  const [displayName, setDisplayName] = useState(() => {
    try {
      const cached = localStorage.getItem('scrum-poker-name')
      if (cached) return cached
    } catch (e) {}
    const idx = Math.floor(Math.random() * DEFAULT_NAMES.length)
    return DEFAULT_NAMES[idx]
  })

  // joined: kullanıcı room participants'a eklenmiş mi?
  const [joined, setJoined] = useState(false)
  const [user, setUser] = useState(null)
  const [room, setRoom] = useState(null)
  const [myVote, setMyVote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dealt, setDealt] = useState(false)
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine)
  const [timer, setTimer] = useState({ hours: 0, minutes: 0, seconds: 0 })
  const [toastMessage, setToastMessage] = useState(null);
  const navigate = useNavigate()
  const roomRef = useMemo(() => ref(db, `rooms/${roomId}`), [roomId])
  const pRef = useMemo(() => user ? ref(db, `rooms/${roomId}/participants/${user.uid}`) : null, [roomId, user])

  // moderator mu?
  const isModerator = useMemo(() => !!(user && room && room.owner === user.uid), [user, room])

  // Resilient update helper: retries on transient errors that abort transactions
  const safeUpdate = async (targetRef, payload, maxRetries = 3) => {
    let attempt = 0;
    while (true) {
      try {
        await update(targetRef, payload);
        return;
      } catch (e) {
        attempt++;
        const msg = e && (e.message || e.toString());
        console.error('safeUpdate error (attempt', attempt, ')', msg, 'for', targetRef && targetRef.path && targetRef.path.toString ? targetRef.path.toString() : targetRef);
        if (attempt >= maxRetries) throw e;
        // backoff
        await new Promise(r => setTimeout(r, 150 * attempt));
      }
    }
  }

  useEffect(() => {
    ensureAuth()
      .then((u) => {
        setUser(u);
        console.log('User authenticated:', u); // Kullanıcı oturum bilgisi
      })
      .catch((error) => {
        console.error('Authentication failed:', error); // Oturum açma hatası
      });
  }, [])

  // Network online/offline detection to avoid attempting DB writes while disconnected
  useEffect(() => {
    const onOffline = () => {
      console.warn('Detected offline status');
      setIsOffline(true);
      setToastMessage('You are offline — actions are queued until connection returns');
    };
    const onOnline = () => {
      console.log('Back online');
      setIsOffline(false);
      setToastMessage('Back online — syncing...');
      // optional: could trigger a refresh/sync here
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [])

  // Odaya bağlan ve realtime dinle (sadece dinleme burada; "katıl" işlemi ayrı)
  useEffect(() => {
    if (!user) return;

    // Firebase bağlantı durumu loglama
    try {
      // Only remove the participant node on disconnect for normal users.
      // Removing the whole room should only be set by the moderator.
      if (pRef) {
        try {
          // Instead of removing the participant node on disconnect (which can be triggered
          // by transient network issues or VPN), set a disconnectedAt timestamp so we can
          // distinguish explicit leaves from transient disconnects.
          try {
            const discPath = `rooms/${roomId}/participants/${user.uid}/disconnectedAt`;
            // Always use modular ref to avoid mixed SDK/compat objects in production bundles.
            const discRef = ref(db, discPath);
            // helpful debug when running into production mismatched bundle issues
            if (pRef) console.debug('pRef present type:', typeof pRef, pRef && pRef.constructor && pRef.constructor.name);
            onDisconnect(discRef).set(Date.now());
            console.log('onDisconnect set for participant.disconnectedAt:', user.uid);
          } catch (err) {
            console.error('onDisconnect set failed for participant.disconnectedAt:', err);
          }
        } catch (err) {
          console.error('Failed to set onDisconnect for participant.disconnectedAt:', err);
        }
      } else {
        console.warn('pRef not available yet; participant onDisconnect not set (user:', user && user.uid, ')');
      }
      // Do not call onDisconnect(roomRef).remove() here — that will delete the whole room
      // when any connection drops. The moderator effect handles room-level onDisconnect.
    } catch (error) {
      console.error('General onDisconnect setup failed:', error);
    }

    // Oda verisi güncellemelerini loglama
    const onValueCallback = (snap) => {
      if (!snap.exists()) {
        console.warn('Room does not exist or was deleted:', roomId); // Oda silinmiş
        onLeave(); // App.jsx’teki setMode('home') tetiklenecek
        return;
      }

      const data = snap.val();
      console.log('Room data updated:', data); // Oda verisi güncellendi
      setRoom(data);

      const currentVote = data?.participants?.[user.uid]?.vote ?? null;
      setMyVote(currentVote);
      setLoading(false);

      if (data?.participants?.[user.uid]) {
        setJoined(true);
        console.log('User rejoined room:', user.uid); // Kullanıcı yeniden bağlandı
      }

      if (data?.kicks?.[user.uid]) {
        console.warn('User was kicked from the room:', user.uid); // Kullanıcı atıldı
        try {
          remove(ref(db, `rooms/${roomId}/kicks/${user.uid}`));
        } catch (e) {
          console.error('Failed to remove kick flag:', e);
        }
        setTimeout(() => {
          onLeave();
          navigate('/');
        }, 50);
      }

      if (data && !data.owner && mounted) {
        console.warn('Room owner left, redirecting participants:', roomId); // Moderator ayrıldı
        onLeave();
        setTimeout(() => {
          navigate('/');
          window.location.reload();
        }, 100);
      }
    };

    const unloadHandler = () => {
      try {
        if (pRef && joined) {
          console.log('Marking participant disconnectedAt on unload (transient):', user.uid);
          try { set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), Date.now()) } catch (e) {}
        }
      } catch (e) {
        console.error('Failed to mark participant disconnected on unload:', e);
      }
    };

  let mounted = true;
    (async () => {
      try {
        const snap = await get(roomRef);
        console.log('Initial room data:', snap.val()); // İlk oda verisi

        // runTransaction işlemi sırasında hata loglama
        try {
          console.log('Running owner-assign transaction for room:', roomId, 'user:', user.uid);
          await runTransaction(roomRef, (current) => {
            if (current == null) {
              console.log('Creating new room (transaction):', roomId); // Yeni oda oluşturuluyor
              return {
                createdAt: Date.now(),
                state: 'voting',
                story: '',
                participants: {},
                owner: user.uid,
              };
            }
            if (!current.owner) {
              console.log('Assigning owner to room (transaction):', user.uid); // Owner atanıyor
              current.owner = user.uid;
            }
            return current;
          });
          console.log('Owner transaction completed for room:', roomId);
        } catch (error) {
          console.error('Failed to run transaction:', error && error.message ? error.message : error); // Transaction hatası
        }

        window.addEventListener('beforeunload', unloadHandler);
        onValue(roomRef, onValueCallback);
      } catch (error) {
        console.error('Failed to initialize room:', error); // Oda başlatma hatası
      }
    })();

    return () => {
      if (!mounted) return;
      mounted = false;
      try {
        if (pRef && joined) {
          console.log('Cleaning up participant:', user.uid); // Katılımcı temizleniyor
          remove(pRef);
        }
      } catch (e) {
        console.error('Failed to clean up participant:', e);
      }
      window.removeEventListener('beforeunload', unloadHandler);
      off(roomRef, 'value', onValueCallback);
    };
  }, [user, roomId])

  // Oy kullanma işlemi
  const castVote = async (value) => {
    if (!user || !room || room.state !== 'voting') return;
    if (isOffline) {
      setToastMessage('Cannot vote while offline');
      console.warn('Attempted to cast vote while offline');
      return;
    }
    console.log('Casting vote:', value); // Oy kullanılıyor
    setMyVote(value);
    try {
      await set(ref(db, `rooms/${roomId}/participants/${user.uid}/vote`), value);
    } catch (error) {
      console.error('Failed to cast vote via set():', error); // Oy kullanma hatası
    }
  }

  // Oda durumunu açığa çıkarma
  const reveal = async () => {
    try {
      console.log('Attempting transaction to set room state -> revealed for', roomId);
      await runTransaction(roomRef, (current) => {
        if (!current) return current;
        current.state = 'revealed';
        return current;
      });
      console.log('Room state transaction completed: revealed');
    } catch (error) {
      console.error('Failed to set room state to revealed via transaction:', error);
    }
  }

  // Oda sıfırlama
  const reset = async () => {
    try {
      console.log('Attempting transaction to reset room:', roomId);
      const newResetId = uuidv4();
      await runTransaction(roomRef, (current) => {
        if (!current) return current;
        if (!current.participants) current.participants = {};
        Object.keys(current.participants).forEach((uid) => {
          if (current.participants[uid]) current.participants[uid].vote = null;
        });
        current.state = 'voting';
        current.resetEvent = newResetId;
        return current;
      });
      console.log('Room reset transaction completed:', newResetId);
    } catch (error) {
      console.error('Failed to reset room via transaction:', error);
    }
    setMyVote(null);
  };

  const setStory = async (story) => {
    try {
      // write only the child 'story' to reduce conflicts with transactions on the root
      await set(ref(db, `rooms/${roomId}/story`), story);
    } catch (e) {
      console.error('Failed to set story:', e);
    }
  }

  // Moderatör: ilk giren
  

  const participants = useMemo(() => {
    return Object.entries(room?.participants || {})
      .map(([uid, p]) => ({ uid, ...p }))
      .sort((a,b)=> (a.joinedAt||0)-(b.joinedAt||0))
  }, [room])

  // sadece anlamlı oy değerlerini al (null/undefined/empty atla)
  const votes = participants.map(p => p.vote).filter(v => v !== null && v !== undefined && v !== '')

  const allVoted = useMemo(() => {
    if(!participants || participants.length === 0) return false
    return participants.every(p => p.vote && p.vote !== '')
  }, [participants])

  // Ortalama hesapla ve en yakın poker kartına yuvarla
  const averageVote = useMemo(() => {
    if (!votes.length) return null
    const numericVotes = votes
      .map(v => {
        if (v == null) return NaN
        const s = String(v).replace('1/2','0.5').replace(',', '.')
        return parseFloat(s)
      })
      .filter(n => !isNaN(n))
    if(numericVotes.length === 0) return null
    const avg = numericVotes.reduce((a,b)=>a+b,0)/numericVotes.length

    // sadece sayısal kartları al (örn '1/2' -> 0.5), '?' ve '♾' atlanır
    const numericCards = CARDS
      .map(c => ({ label: c, val: parseFloat(c.replace('1/2','0.5')) }))
      .filter(c => !isNaN(c.val))

    // en yakını bul, eşit uzaklıkta ise daha büyük değeri seç
    let chosen = numericCards[0]
    let minDiff = Math.abs(numericCards[0].val - avg)
    const eps = 1e-9
    numericCards.forEach(c => {
      const diff = Math.abs(c.val - avg)
      if (diff < minDiff - eps) {
        minDiff = diff
        chosen = c
      } else if (Math.abs(diff - minDiff) < eps) {
        // eşitse üstü seç (büyük olan)
        if (c.val > chosen.val) chosen = c
      }
    })

    return { avg: avg.toFixed(2), rounded: chosen.label }
  }, [votes, allVoted])

  // moderator için katılımcıyı atma
  const kickParticipant = async (uid) => {
    if (!isModerator) return
    if (!confirm('Bu katılımcıyı odadan atmak istediğinize emin misiniz?')) return
    // set işlemi sırasında hata loglama
    try {
      const kicksRef = ref(db, `rooms/${roomId}/kicks`);
      // Use a transaction on the kicks object to avoid conflicts with transactions higher in the tree
      try {
        await runTransaction(kicksRef, (cur) => {
          if (cur == null) cur = {};
          cur[uid] = true;
          return cur;
        });
        console.log('Kick flag transaction completed for user:', uid); // Kullanıcı atıldı
      } catch (txErr) {
        console.warn('Kick transaction failed, falling back to set for', uid, txErr && (txErr.message || txErr.toString()));
        // fallback: try a narrow set with a small retry
        const kickRef = ref(db, `rooms/${roomId}/kicks/${uid}`);
        let attempt = 0;
        while (attempt < 3) {
          try {
            await set(kickRef, true);
            console.log('Kick flag set for user (fallback):', uid);
            break;
          } catch (e) {
            attempt++;
            console.error('Fallback set attempt', attempt, 'failed for kick', uid, e && (e.message || e.toString()));
            await new Promise(r => setTimeout(r, 150 * attempt));
            if (attempt >= 3) throw e;
          }
        }
      }
    } catch (error) {
      console.error('Failed to set kick flag:', error && (error.message || error.toString()), { roomId, uid, stack: error && error.stack }); // Set hatası
    }
    // kısa bekleme, ardından serverdan participant node'u kaldır
    setTimeout(async () => {
      try { await remove(ref(db, `rooms/${roomId}/participants/${uid}`)) } catch(e) {}
    }, 200)
  }

  // Moderator ayrılırsa/bağlantısı koparsa oda tamamen silinsin
  useEffect(() => {
    if (!isModerator) return
    // Avoid using onDisconnect(roomRef).remove() because it may cause the room to be
    // deleted unexpectedly if ownership races occur. Instead, attempt a guarded remove
    // on unload that checks the current owner in the DB before removing.
    const modUnload = async () => {
      try {
        console.log('Moderator unload triggered, verifying ownership before removing room:', roomId, 'user:', user && user.uid);
        const snap = await get(roomRef);
        const data = snap && snap.val();
        if (data && data.owner === user?.uid) {
          console.log('Confirmed owner on unload; removing room:', roomId);
          await remove(roomRef);
        } else {
          console.warn('Not owner at unload, skipping room remove. Current owner:', data && data.owner);
        }
      } catch (e) {
        console.error('Error during moderator unload remove:', e);
      }
    }

    window.addEventListener('beforeunload', modUnload)

    return () => {
      window.removeEventListener('beforeunload', modUnload)
    }
  }, [isModerator, roomRef])

  // displayName değiştiğinde hem localStorage'e kaydet hem DB'yi güncelle (eğer user varsa)
  useEffect(() => {
    try { localStorage.setItem('scrum-poker-name', displayName) } catch(e){}
    if (!user) return
    if (!roomId || !user.uid) {
      console.warn('Skipping displayName set: missing roomId or user.uid', { roomId, uid: user && user.uid })
      return
    }
    const nameRef = ref(db, `rooms/${roomId}/participants/${user.uid}/name`)
    ;(async () => {
      try {
        await set(nameRef, displayName)
      } catch(e) {
        console.error('Failed to set displayName via set()', e && (e.message || e.toString()) , {
          roomId, uid: user.uid, displayName, nameRefPath: `rooms/${roomId}/participants/${user.uid}/name`
        })
        // attach stack if available for easier mapping in prod
        if (e && e.stack) console.error('Error stack:', e.stack)
      }
    })()
  }, [displayName, user, roomId])

  // kullanıcı "Katıl" butonuna basınca participant olarak kayıt ol
  const joinRoom = async () => {
    if (!user) return
    if (isOffline) {
      setToastMessage('Cannot join room while offline');
      console.warn('Attempted to join while offline');
      return
    }
    try {
      // First, ensure room exists. Create with set() if missing to avoid large-root transactions.
      try {
        const snap = await get(roomRef);
        if (!snap.exists()) {
          console.log('Room missing, creating root with transaction for', roomId);
          try {
            await runTransaction(roomRef, (current) => {
              if (current == null) {
                return {
                  createdAt: Date.now(),
                  state: 'voting',
                  story: '',
                  participants: {},
                  owner: user.uid,
                };
              }
              return current;
            });
          } catch (e) {
            console.warn('room creation transaction failed', e);
          }
        } else {
          const data = snap.val();
          if (!data.owner) {
            // transact only on the owner child to avoid aborting transactions on other children
            const ownerRef = ref(db, `rooms/${roomId}/owner`);
            try {
              await runTransaction(ownerRef, (cur) => cur || user.uid);
            } catch (e) {
              console.warn('owner child tx ignored', e);
            }
          }
        }
      } catch (e) {
        console.warn('Error ensuring room exists/owner assignment', e);
      }

      // Then write participant entry directly to the narrow participant path
      try {
        await set(pRef, {
          name: displayName,
          vote: null,
          joinedAt: Date.now(),
          disconnectedAt: null
        });
        // start heartbeat to indicate presence
        try {
          const hbId = setInterval(() => {
            set(ref(db, `rooms/${roomId}/participants/${user.uid}/lastSeen`), Date.now()).catch(()=>{});
          }, 15000);
          window.__scrumPokerHeartbeat = window.__scrumPokerHeartbeat || {};
          window.__scrumPokerHeartbeat[user.uid] = hbId;
        } catch(e) { console.warn('Failed to start heartbeat', e) }
      } catch (e) {
        console.error('Failed to set participant entry on join:', e);
        throw e;
      }

    // Cancel any onDisconnect for participant.disconnectedAt (we manage cleanup via heartbeat/TTL)
    try {
      const discPath = `rooms/${roomId}/participants/${user.uid}/disconnectedAt`;
      const discRefCancel = ref(db, discPath);
      const od = onDisconnect(discRefCancel);
      if (od && typeof od.cancel === 'function') od.cancel();
    } catch (e) {
      console.warn('Failed to cancel onDisconnect for participant.disconnectedAt', e);
    }
      try { localStorage.setItem('scrum-poker-name', displayName) } catch(e){}
      setJoined(true)
    } catch (e) {
      console.error('Join failed', e)
    }
  }

  // If we go back online and our participant entry was removed from the server,
  // try to recreate it automatically (auto-rejoin) to avoid 'missing participants' after transient disconnects.
  useEffect(() => {
    if (isOffline) return;
    if (!user || !roomId) return;
    // only attempt if we think we previously joined
    if (!joined) return;
    try {
      const exists = !!room?.participants?.[user.uid];
      if (!exists) {
        console.log('Auto-rejoining participant after reconnect for', user.uid);
        const pr = ref(db, `rooms/${roomId}/participants/${user.uid}`);
        set(pr, { name: displayName, vote: null, joinedAt: Date.now() }).catch((e) => console.error('Auto-rejoin failed', e));
      }
    } catch (e) {
      console.error('Auto-rejoin check failed', e);
    }
  }, [isOffline, user, joined, roomId, room, displayName]);

  // komponent içinde (örn. diğer handler'ların yanında) ekleyin:
  const handleReveal = async () => {
    if (!room) return
  try { await reveal() } catch (e) { console.error('handleReveal failed', e) }
  }

  // triggerDeal uses the dealt state declared earlier
  const triggerDeal = () => {
    // restart animation: brief reset then staggered anims play
    setDealt(false);
    // small delay so CSS animation retriggers
    const t1 = setTimeout(() => setDealt(true), 150); // smoother delay
    const t2 = setTimeout(() => setDealt(false), 2000); // shorter cleanup
    // return cleanup function for callers if needed
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }

  // Remove triggerDeal from useEffect
  useEffect(() => {
    if (room?.state === 'voting') {
      setDealt(false); // Ensure dealt state resets
    }
  }, [room?.state])

  useEffect(() => {
    if (room?.resetEvent) {
      console.log('Reset event detected, triggering deal animation'); // Debugging log
      triggerDeal();
    }
  }, [room?.resetEvent])

  // Timer her saniye güncellenir
  useEffect(() => {
    const interval = setInterval(() => {
      setTimer((prev) => {
        const totalSeconds = prev.hours * 3600 + prev.minutes * 60 + prev.seconds + 1;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return { hours, minutes, seconds };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const calculateDeviation = (votes) => {
    if (votes.length < 2) return [];

    const numericVotes = votes
      .map(v => parseFloat(v.replace('1/2', '0.5')))
      .filter(v => !isNaN(v));

    const avg = numericVotes.reduce((a, b) => a + b, 0) / numericVotes.length;
    const deviations = numericVotes.map(v => Math.abs(v - avg));
    const maxDeviation = Math.max(...deviations);

    return numericVotes.map((v, i) => deviations[i] === maxDeviation && deviations[i] > avg * 0.5);
  };

  const deviations = useMemo(() => calculateDeviation(votes), [votes]);

  // Keep theme in React state so the Room re-renders immediately when theme changes.
  const [themeState, setThemeState] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');

  useEffect(() => {
    // keep in sync if another tab or part of the app updates the theme
    const onStorage = (e) => {
      if (e.key === 'scrum-poker-theme') {
        setThemeState(e.newValue || document.documentElement.getAttribute('data-theme') || 'light');
      }
    };
    window.addEventListener('storage', onStorage);

    // MutationObserver: catch direct attribute changes to <html data-theme="...">
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'data-theme') {
          setThemeState(document.documentElement.getAttribute('data-theme') || 'light');
        }
      }
    });
    mo.observe(document.documentElement, { attributes: true });

    return () => {
      window.removeEventListener('storage', onStorage);
      mo.disconnect();
    };
  }, []);

  const toggleTheme = () => {
    const newTheme = themeState === 'dark' ? 'light' : 'dark';
    try { document.documentElement.classList.add('disable-transitions'); } catch (e) {}
    document.documentElement.setAttribute('data-theme', newTheme);
    try { localStorage.setItem('scrum-poker-theme', newTheme); } catch (e) { console.error('Failed to save theme to localStorage', e); }
    setThemeState(newTheme);
    setTimeout(() => { try { document.documentElement.classList.remove('disable-transitions'); } catch (e) {} }, 60);
  };

  useEffect(() => {
    if (!toastMessage) return;
    // If offline toast is shown, keep it until we go back online
    if (toastMessage.toLowerCase().includes('offline')) {
      return; // persist until online event clears it
    }
    const timer = setTimeout(() => {
      setToastMessage(null);
    }, 3000); // Hide after 3 seconds for non-offline toasts

    return () => clearTimeout(timer); // Cleanup timeout on unmount or re-trigger
  }, [toastMessage]);

  useEffect(() => {
    console.log('isModerator:', isModerator);
    console.log('room.state:', room?.state);
  }, [isModerator, room?.state]);

  if(loading) return <div className="container"><div className="card">Loading room…</div></div>
  // room nesnesi null ise kullanıcıyı ana sayfaya yönlendir
  if (!room) {
    return <div className="container"><div className="card">Loading room data...</div></div>;
  }

  // Davet linkini oluşturmak için bir state ekleyelim
  const inviteLink = `${window.location.origin}/#/?roomId=${roomId}`;

  const roomState = room?.state || 'voting';

  return (
  <div className={`room-container ${themeState}`}>
      <div className="theme-switcher">
      <label className="switch" aria-label="Toggle theme">
        <input
          type="checkbox"
          checked={themeState === 'dark'}
          onChange={toggleTheme}
          aria-checked={themeState === 'dark'}
        />
        <span className="slider">
          <span className="icon sun" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" fill="currentColor" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </g>
            </svg>
          </span>
          <span className="icon moon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" fill="currentColor" />
            </svg>
          </span>
        </span>
      </label>
  <span className="theme-label">{themeState === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
    </div>
      <div className="container">
        <div className="card p-3">
          <div className="timer">
          <span>{timer.hours.toString().padStart(2, '0')}:</span>
          <span>{timer.minutes.toString().padStart(2, '0')}:</span>
          <span>{timer.seconds.toString().padStart(2, '0')}</span>
        </div>
          <div className="header">
            <div className="room-info" style={{ display: 'flex', alignItems: 'center' }}>
              <div className="small">Room :</div>
              <div className="copy" style={{ fontSize: 20, marginRight: '8px' }}>{roomId}</div>
              <button
                className="btn-icon btn btn-sm btn-outline-secondary"
                onClick={() => {
                  const inviteLink = `${window.location.origin}/room/${roomId}`;
                  navigator.clipboard.writeText(inviteLink);
                  setToastMessage('Invite link copied to clipboard!');
                }}
                style={{ display: 'flex', alignItems: 'center', padding: '4px' }}
              >
                <img src="/invite-icon.svg" alt="Invite" style={{ width: '16px', height: '16px', marginRight: '4px' }} />
                Invite
              </button>

              {/* Toast Notification */}
              {toastMessage && (
                <div className="toast-notification">
                  {toastMessage}
                </div>
              )}
            </div>
            <div className="status-info" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px', fontWeight: 'bold', color: '#ff4b4b' }}>
              <div className="small">Scrum master :</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#22d3ee' }}>
                {room?.owner ? (room?.participants?.[room.owner]?.name || room.owner) : '—'}
              </div>
              <div className="small">Status :</div>
              <span className="badge" style={{ padding: '7px 8px', borderRadius: '4px', backgroundColor: '#ff4b4b', color: '#fff' }}>
                {roomState === 'voting' ? 'Voting' : 'Revealed'}
              </span>
            </div>
            <div className="actions">
              <button
                className="btn"
                onClick={() => {
                  navigator.clipboard.writeText(roomId);
                  setToastMessage('Room code copied to clipboard!');
                }}
              >
                <img src="/copy-icon.svg" alt="Copy" style={{ width: '16px', height: '16px', marginRight: '4px' }} />
                Copy Code
              </button>
              <button
                className="btn btn-outline-secondary"
                onClick={async () => {
                  onLeave();
                  try {
                    if (isModerator) {
                      remove(roomRef);
                    } else {
                      remove(ref(db, `rooms/${roomId}/participants/${user.uid}`));
                    }
                    // clear heartbeat if present
                    try { clearInterval(window.__scrumPokerHeartbeat && window.__scrumPokerHeartbeat[user.uid]) } catch (e) {}
                    setTimeout(() => {
                      window.location.href = "/"
                    }, 100)
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <img src="/leave-icon.svg" alt="Leave" style={{ width: '16px', height: '16px', marginRight: '4px' }} />
                Leave
              </button>
            </div>
          </div>

          <div className="row" style={{alignItems:'center', justifyContent:'space-between'}}>
            <input className="input" placeholder="Story title (optional)" value={room?.story || ''} onChange={e=> setStory(e.target.value)} />
          </div>

          <div style={{height:12}}/>
          <div>
            <div className="small" style={{marginBottom:8}}>Participants</div>
            <div className="row">
              {participants.map((p, i) => { // `i` indeksini ekledim
                const voted = !!p.vote;
                const isMe = user && p.uid === user.uid;
                const AVATAR = avatarFor(p.uid);
                return (
                  <div
                    key={p.uid}
                    className={`participant-card poker ${voted ? 'voted' : 'not-voted'} ${isMe ? 'me' : ''} ${room?.owner === p.uid ? 'moderator' : ''}`}
                    aria-current={isMe}
                  >
                    {/* flip only when room is revealed */}
                    <div className={`card-visual ${room?.state === 'revealed' ? 'flipped' : ''}`} aria-hidden>
                      <div className="card-side card-back" />
                      <div className="card-side card-front">
                        <div className="card-border">
                          <div className="card-value">
                            { room?.state === 'revealed' ? (
                              p.vote === '☕' ? (
                                <div className="pause-cafe">
                                  <div className="pause-title">Pause Cafe</div>
                                  <div className="pause-icon">☕</div>
                                </div>
                              ) : (
                                p.vote || '-'
                              )
                            ) : '' }
                          </div>
                        </div>
                      </div>
                    </div>
                     <div className="p-info">
                       <div className="p-name">
                         {p.name || 'Anonymous'}
                         {isMe && <span className="me-badge" aria-hidden> You</span>}
                         {room?.state === 'revealed' && (deviations[i] || ['?', '♾'].includes(p.vote)) && (
                          <span className="surprise-icon" title="Confused">😲</span>
                        )}
                       </div>
                      <div className="p-status">{voted ? '👍 Voted' : '⏳ Waiting'}</div>
                     </div>
                     {isModerator && user?.uid !== p.uid && (
                       <button
                         className="kick-btn"
                         onClick={() => kickParticipant(p.uid)}
                         title="Kick participant"
                         aria-label={`Kick ${p.name || 'participant'}`}
                       >
                         X
                       </button>
                     )}
                   </div>
                 )
               })}
            </div>
          </div>

          <div style={{height:10}}/>
          <div className="footer">
            <div className="button-group">
              {isModerator && room.state === 'voting' && (
                <div className="button-container">
                  <button className="btn-circle" onClick={handleReveal}>
                    <img src="/reveal-icon.svg" alt="Reveal" className="icon" />
                  </button>
                  <div className="button-label">Reveal</div>
                </div>
              )}
              {isModerator && room.state === 'revealed' && (
                <div className="button-container">
                  <button className="btn-circle" onClick={reset}>
                    <img src="/reset-icon.svg" alt="Reset" className="icon" />
                  </button>
                  <div className="button-label">Restart</div>
                </div>
              )}
            </div>
            {room.state === 'revealed' && (
              <div className="results">
                <div className="small" style={{ marginBottom: 8 }}>Results</div>
                <div className="row">
                  {averageVote && (
                    <div className="participant" style={{ flex: '1 1 40px' }}>
                      <div>Average: {averageVote.avg}</div>
                      <div style={{ fontWeight: 500 }}>Rounded: {averageVote.rounded}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div style={{height:5}}/>
          <div>
            <div className="small" style={{marginBottom:8}}>Choose your card</div>
            <div style={{height:8}}/>
            <div className="grid">
              {CARDS.map((c, i) => {
                const startRot = (i % 2 === 0) ? -8 : 8;
                return (
                  <button
                    key={c}
                    className={`cardBtn poker ${myVote === c ? 'active' : ''} ${dealt ? 'dealt' : ''}`}
                    onClick={() => castVote(c)}
                    disabled={room?.state !== 'voting'}
                    aria-pressed={myVote === c}
                    style={dealt ? { animationDelay: `${i * 70}ms`, ['--start-rot']: `${startRot}deg` } : undefined}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150" className="card-svg">
        <rect x="0" y="0" width="100" height="150" rx="10" ry="10" fill="white" stroke="red" strokeWidth="2" />
        <text x="50" y="80" fontSize="36" textAnchor="middle" fill="black" fontFamily="Arial">{c}</text>
        <text x="10" y="20" fontSize="12" fill="black" fontFamily="Arial">{c}</text>
        <text x="80" y="135" fontSize="12" fill="black" fontFamily="Arial">{c}</text>
      </svg>
                  </button>
                );
              })}
             </div>
          </div>

        </div>

        
      </div>
    </div>
  )
}