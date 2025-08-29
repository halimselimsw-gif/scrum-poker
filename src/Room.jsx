import React, { useEffect, useMemo, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ref, onValue, set, update, get, remove, onDisconnect, off, runTransaction } from 'firebase/database'
import { db, ensureAuth } from './firebase'
import './room.css'
import { v4 as uuidv4 } from 'uuid'; // Import UUID library
const CARDS = ['0','1','2','3','5','8','13','21','34', '55','89','?','♾','☕']

const DELETE_GRACE_MS = 30 * 1000; // 30s grace before deleting room after moderator disconnect

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

  // persistent client id per browser to help rejoin/dedupe across anonymous auth resets
  const [clientId] = useState(() => {
    try {
      let id = localStorage.getItem('scrum-poker-client-id')
      if (!id) {
        id = uuidv4()
        try { localStorage.setItem('scrum-poker-client-id', id) } catch (e) {}
      }
      return id
    } catch (e) {
      return uuidv4()
    }
  })

  // session id for this page/tab load — used to scope onDisconnect writes
  const [sessionId] = useState(() => {
    try {
      return uuidv4();
    } catch (e) {
      return String(Date.now());
    }
  })

  // Remove noisy debug output at runtime; keeps console.error intact.
  try {
    const __stripRoomDebug = true;
    if (__stripRoomDebug) {
      console.log = () => {};
      console.debug = () => {};
      console.warn = () => {};
    }
  } catch (e) {}


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
  // debug log removed
      })
      .catch((error) => {
        console.error('Authentication failed:', error); // Oturum açma hatası
      });
  }, [])

  // Network online/offline detection to avoid attempting DB writes while disconnected
  useEffect(() => {
    const onOffline = () => {
      setIsOffline(true);
      setToastMessage('You are offline — actions are queued until connection returns');
    };
    const onOnline = () => {
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
            // Write both disconnectedAt and disconnectedSession so we can ignore
            // stale disconnects that belong to a previous session.
            const discAtPath = `rooms/${roomId}/participants/${user.uid}/disconnectedAt`;
            const discSessionPath = `rooms/${roomId}/participants/${user.uid}/disconnectedSession`;
            const discAtRef = ref(db, discAtPath);
            const discSessionRef = ref(db, discSessionPath);
            // debug info removed
            try {
              // write boolean true on disconnect
              onDisconnect(discAtRef).set(true);
            } catch(e) { console.warn('onDisconnect(discAtRef) failed', e) }
            try {
              onDisconnect(discSessionRef).set(sessionId);
            } catch(e) { console.warn('onDisconnect(discSessionRef) failed', e) }
            // onDisconnect set
          } catch (err) {
            console.error('onDisconnect set failed for participant.disconnectedAt/disconnectedSession:', err);
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
        // room missing
        onLeave(); // App.jsx’teki setMode('home') tetiklenecek
        return;
      }

      const data = snap.val();
  // room data updated
      setRoom(data);

      const currentVote = data?.participants?.[user.uid]?.vote ?? null;
      setMyVote(currentVote);
      setLoading(false);

      if (data?.participants?.[user.uid]) {
        setJoined(true);
      }

      if (data?.kicks?.[user.uid]) {
        // user was kicked
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

      // If a moderator scheduled a deletion marker and it's older than the grace
      // window, allow a connected client to remove the room. This avoids
      // immediate deletion on transient network blips.
      try {
        const m = data && data.markedForDeletionAt;
        if (m && (Date.now() - m) > DELETE_GRACE_MS) {
          // attempt to remove via transaction to avoid races
          (async () => {
            try {
              await runTransaction(roomRef, (current) => {
                if (!current) return current;
                if (!current.markedForDeletionAt) return current;
                if ((Date.now() - current.markedForDeletionAt) > DELETE_GRACE_MS) {
                  // remove the room
                  return null;
                }
                return current;
              });
            } catch (e) {
              console.error('Failed to remove room after deletion marker expired:', e);
            }
          })();
        }
      } catch (e) {
        console.error('Error checking markedForDeletionAt:', e);
      }
    };

    const unloadHandler = () => {
      try {
        if (pRef && joined) {
            console.log('Marking participant disconnectedAt=true (transient) on unload:', user.uid);
          try { set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), true) } catch (e) {}
        }
      } catch (e) {
        console.error('Failed to mark participant disconnected on unload:', e);
      }
    };

  let mounted = true;
    (async () => {
      try {
        // helper: get with retries to handle transient network/permission blips
        const getWithRetry = async (attempts = 5, baseDelay = 200) => {
          for (let i = 0; i < attempts; i++) {
            try {
              const snap = await get(roomRef);
              return snap;
            } catch (e) {
              console.error('get(roomRef) attempt', i + 1, 'failed:', e && (e.message || e.toString()));
            }
            // backoff
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
          }
          return null;
        };

        const snap = await getWithRetry(5, 150);
        // initial room data fetched (or null after retries)

        // Do not create a room implicitly here. If the room doesn't exist after
        // several attempts, abort to avoid permission/set errors. This avoids
        // intermittent failures where a transient DB error returns empty.
        if (!snap || !snap.exists()) {
          console.error('Room does not exist after retries; aborting owner-assign to avoid creating room:', roomId);
          setToastMessage('Room not found or temporarily unavailable. Please try again.');
          onLeave();
          navigate('/');
          return;
        }

        // run owner-assign transaction with a few retries
        const runTransactionWithRetry = async (attempts = 3, baseDelay = 150) => {
          for (let i = 0; i < attempts; i++) {
            try {
              await runTransaction(roomRef, (current) => {
                if (!current) return current;
                if (!current.owner) current.owner = user.uid;
                return current;
              });
              return;
            } catch (e) {
              console.error('owner-assign transaction attempt', i + 1, 'failed:', e && (e.message || e.toString()));
            }
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
          }
          // final fallback: log and continue; not critical to block user further
          console.error('owner-assign transaction failed after retries; continuing without owner assign');
        };

        await runTransactionWithRetry(3, 150);

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
    setMyVote(value);
    try {
      // Ensure presence flag cleared when the user takes an action (vote)
      try {
        await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false);
        // clear reveal-offline marker so this user returns online
        await set(ref(db, `rooms/${roomId}/participants/${user.uid}/revealOffline`), null);
      } catch (e) { /* ignore */ }

      await set(ref(db, `rooms/${roomId}/participants/${user.uid}/vote`), value);
    } catch (error) {
      console.error('Failed to cast vote via set():', error); // Oy kullanma hatası
    }
  }

  // Oda durumunu açığa çıkarma
  const reveal = async () => {
    try {
      // When revealing, set room state to 'revealed' and mark non-voters revealOffline=true
      await runTransaction(roomRef, (current) => {
        if (!current) return current;
        current.state = 'revealed';
        if (current.participants) {
          for (const [uid, p] of Object.entries(current.participants)) {
            // skip the room owner (moderator) — don't mark them offline
            if (current.owner && uid === current.owner) continue;
            // if participant hasn't voted (null/undefined/empty) mark them as revealOffline
            if (!p || p.vote === null || p.vote === undefined || p.vote === '') {
              current.participants[uid] = Object.assign({}, p, { revealOffline: true, disconnectedAt: true });
            }
          }
        }
        return current;
      });
    } catch (error) {
      console.error('Failed to set room state to revealed via transaction:', error);
    }
  }

  // Oda sıfırlama
  const reset = async () => {
    if (isOffline) {
      setToastMessage('Cannot Reset while offline');
      return;
    }
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
    const raw = Object.entries(room?.participants || {}).
      map(([uid, p]) => ({ uid, ...p }));

    // Dedupe by clientId when available, otherwise by name. Keep the most
    // recently active record (by lastSeen or joinedAt) to avoid showing stale
    // offline duplicates when a participant rejoins.
    const mapByKey = new Map();
    for (const p of raw) {
      const key = p.clientId || (p.name ? String(p.name).trim() : p.uid);
      const existing = mapByKey.get(key);
      const existingScore = existing ? ((existing.lastSeen || existing.joinedAt || 0)) : 0;
      const pScore = (p.lastSeen || p.joinedAt || 0);
      if (!existing || pScore >= existingScore) {
        mapByKey.set(key, p);
      }
    }

    const out = Array.from(mapByKey.values());
    out.sort((a,b)=> (a.joinedAt||0)-(b.joinedAt||0));
    return out;
  }, [room?.participants])

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

    // For moderators, schedule a room removal when their connection drops.
    // We also keep a beforeunload handler that verifies ownership immediately
    // and removes the room synchronously if still owner. Always cancel the
    // onDisconnect when the moderator effect is torn down to avoid accidental
    // deletes if ownership changes.
    let onDiscObj = null;

    const modUnload = async () => {
      try {
        console.log('Moderator unload triggered, verifying ownership before removing room:', roomId, 'user:', user && user.uid);
        const snap = await get(roomRef);
        const data = snap && snap.val();
        if (data && data.owner === user?.uid) {
          console.log('Confirmed owner on unload; removing room:', roomId);
          try { await remove(roomRef); } catch(e) { console.error('Immediate remove failed on unload:', e); }
        } else {
          console.warn('Not owner at unload, skipping room remove. Current owner:', data && data.owner);
        }
      } catch (e) {
        console.error('Error during moderator unload remove:', e);
      }
    }

    (async () => {
      try {
        // Instead of scheduling an immediate remove, mark the room for deletion
        // with a timestamp. A connected client will only remove the room after
        // the grace period. This prevents immediate deletes during transient
        // disconnects (VPN, flaky networks).
        try {
          const markerRef = ref(db, `rooms/${roomId}/markedForDeletionAt`);
          onDiscObj = onDisconnect(markerRef);
          await onDiscObj.set(Date.now());
          // Clear any existing marker now that we're the owner and active
          try { await set(markerRef, null); } catch(e) {}
          console.log('Scheduled onDisconnect to set markedForDeletionAt for room:', roomId);
        } catch (e) {
          console.error('Failed to schedule onDisconnect marker for room:', e);
        }
      } catch (e) {
        console.error('Error setting up moderator onDisconnect:', e);
      }
    })();

    window.addEventListener('beforeunload', modUnload)

    return () => {
      try {
        if (onDiscObj && onDiscObj.cancel) {
          onDiscObj.cancel().catch((e)=>{});
        } else if (onDiscObj) {
          // older SDKs expose cancel as a method that might not return a promise
          try { onDiscObj.cancel(); } catch(e) {}
        }
      } catch (e) {}
      window.removeEventListener('beforeunload', modUnload)
    }
  }, [isModerator, roomRef])

  // If we become moderator or return online, clear any stale deletion marker
  useEffect(() => {
    if (!isModerator || !roomId) return;
    const clearMarker = async () => {
      try {
        const markerRef = ref(db, `rooms/${roomId}/markedForDeletionAt`);
        await set(markerRef, null);
      } catch (e) {
        console.error('Failed to clear markedForDeletionAt on moderator/reactive online:', e);
      }
    };
    // Clear now
    clearMarker();
    // Also clear on browser online event
    const onOnline = () => { clearMarker(); };
    window.addEventListener('online', onOnline);
    return () => { window.removeEventListener('online', onOnline); };
  }, [isModerator, roomId]);

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
          // Do NOT auto-create a room on join. If the room doesn't exist, treat it as missing
          // — creating a room here caused accidental new rooms when rejoining. Redirect out.
          console.warn('Room does not exist; aborting join to avoid accidental room creation:', roomId);
          setToastMessage('Room not found');
          onLeave();
          navigate('/');
          return;
        } else {
          const data = snap.val();
          if (!data.owner) {
            // ensure owner exists but don't create root room
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
          // --- Preserve + Deduplicate logic ---
          // If there are existing participant nodes that appear to belong to
          // this person (same clientId or same displayName + disconnectedAt/stale),
          // capture their data locally, remove those nodes from the DB, and
          // then re-create our participant entry using their preserved data.
          try {
            const partsSnap = await get(ref(db, `rooms/${roomId}/participants`));
            const parts = partsSnap && partsSnap.val() ? partsSnap.val() : {};
            const now = Date.now();
            const STALE_MS = 5 * 60 * 1000; // 5 minutes
            // choose the best candidate to preserve (most recent lastSeen/joinedAt)
            let preserved = null;
            let preservedUid = null;
            for (const [otherUid, pdata] of Object.entries(parts)) {
              try {
                if (!pdata) continue;
                if (otherUid === user.uid) continue;
                if (!displayName) continue;
                const otherClient = pdata.clientId || null;
                const nameMatches = String(pdata.name || '').trim() === String(displayName || '').trim();

                // Prefer same clientId first
                if (otherClient && otherClient === clientId) {
                  // pick the most recent one if multiple
                  const score = pdata.lastSeen || pdata.joinedAt || 0;
                  if (!preserved || (score > (preserved.lastSeen || preserved.joinedAt || 0))) {
                    preserved = pdata;
                    preservedUid = otherUid;
                  }
                  continue;
                }

                // If same name and explicitly disconnected, prefer it
                if (nameMatches && pdata.disconnectedAt === true) {
                  const score = pdata.lastSeen || pdata.joinedAt || 0;
                  if (!preserved || (score > (preserved.lastSeen || preserved.joinedAt || 0))) {
                    preserved = pdata;
                    preservedUid = otherUid;
                  }
                  continue;
                }

                // Fallback: if name matches and no lastSeen or very stale, consider it
                const lastSeen = pdata.lastSeen || pdata.joinedAt || 0;
                const age = now - lastSeen;
                if (nameMatches && (!lastSeen || age > STALE_MS)) {
                  const score = lastSeen || 0;
                  if (!preserved || (score > (preserved.lastSeen || preserved.joinedAt || 0))) {
                    preserved = pdata;
                    preservedUid = otherUid;
                  }
                }
              } catch (innerErr) {
                console.warn('Failed while scanning participants for preservation:', otherUid, innerErr && (innerErr.code || innerErr.message || innerErr.toString()));
              }
            }

            if (preserved && preservedUid) {
              // remove the preserved node(s) from DB so the re-add is clean
              try {
                await remove(ref(db, `rooms/${roomId}/participants/${preservedUid}`));
              } catch (e) {
                // failed to remove preserved node
              }
            }

            // attach preserved data to a local variable for later use in set(pRef)
            // we keep the whole object but will override joinedAt/lastSeen/disconnectedAt
            var preservedData = preserved ? Object.assign({}, preserved) : null;
          } catch (e) {
            console.warn('Participant preservation/dedupe scan failed', e && (e.code || e.message || e.toString()));
          }
        // --- end preserve + dedupe ---
        try {
          // Build the participant payload, preferring preservedData fields where safe
          const nowP = Date.now();
          const base = {
            name: displayName,
            vote: null,
            joinedAt: nowP,
            disconnectedAt: false, // initial false
            clientId,
            sessionId
          };
          if (typeof preservedData === 'object' && preservedData !== null) {
            if (preservedData.vote) base.vote = preservedData.vote;
            for (const k of Object.keys(preservedData)) {
              if (!['name','vote','joinedAt','lastSeen','disconnectedAt','clientId'].includes(k)) base[k] = preservedData[k];
            }
          }

          // First attempt: atomic transaction that upserts our new participant and removes preservedUid/duplicates
            try {
            // attempting rejoin transaction
            const tx = await runTransaction(roomRef, (current) => {
              if (!current) return current;
              if (!current.participants) current.participants = {};
              const parts = current.participants;
              const existing = parts[user.uid] || {};
              parts[user.uid] = Object.assign({}, existing, base, {
                joinedAt: existing.joinedAt || nowP,
                lastSeen: nowP,
                disconnectedAt: false,
                disconnectedSession: null,
              });

              // remove the preserved node if present
              try { if (preservedUid && parts[preservedUid]) delete parts[preservedUid]; } catch(e){}

              // also remove any other duplicates by clientId or same-name+disconnectedAt/stale
              const CLEAN_STALE_MS_T = 30 * 1000;
              for (const otherUid of Object.keys(parts)) {
                if (otherUid === user.uid) continue;
                const pdata = parts[otherUid] || {};
                const otherClient = pdata.clientId || null;
                const nameMatches = String(pdata.name || '').trim() === String(displayName || '').trim();
                if (otherClient && otherClient === clientId) {
                  delete parts[otherUid];
                  continue;
                }
                  // If same name and explicit disconnected exists, only remove
                  // if that disconnectedSession is not our current session (stale)
                  if (nameMatches && pdata.disconnectedAt === true) {
                    const otherDiscSess = pdata.disconnectedSession || null;
                    if (!otherDiscSess || otherDiscSess !== sessionId) {
                      delete parts[otherUid];
                      continue;
                    }
                  }
                if (nameMatches) {
                  const otherLast = pdata.lastSeen || 0;
                  const otherStale = otherLast && ((nowP - otherLast) > CLEAN_STALE_MS_T);
                  if (!otherLast || otherStale) delete parts[otherUid];
                }
              }

              current.participants = parts;
              return current;
            });
            // rejoin transaction result
            // if committed, we've been re-added atomically; ensure disconnectedAt cleared
            if (tx && tx.committed) {
              try { await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false); } catch(e){ /* ignore */ }
              // proceed to start heartbeat later as normal
            } else {
              // rejoin transaction did not commit; falling back to direct set
              // fallback to direct set below
              throw new Error('tx-not-committed');
            }
          } catch (txErr) {
            // If transaction fails or didn't commit, try direct set with retries (fallback path)

            // attempt to remove same-clientId nodes before set
            try {
              const partsSnap2 = await get(ref(db, `rooms/${roomId}/participants`));
              const parts2 = partsSnap2 && partsSnap2.val() ? partsSnap2.val() : {};
              for (const [otherUid, pdata] of Object.entries(parts2)) {
                if (!pdata) continue;
                if (otherUid === user.uid) continue;
                const otherClient = pdata.clientId || null;
                if (otherClient && otherClient === clientId) {
                  try { await remove(ref(db, `rooms/${roomId}/participants/${otherUid}`)); } catch (e) { /* ignore */ }
                }
              }
            } catch (e) { console.warn('Fallback pre-set removal scan failed', e) }

            // direct set with small retry loop
            let attempt = 0;
            let lastErr = null;
      while (attempt < 3) {
              attempt++;
              try {
    await set(pRef, base);
                lastErr = null;
  try { await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false); } catch(e){ /* ignore */ }
                break;
              } catch (e) {
                lastErr = e;
    // fallback set attempt failed
                await new Promise(r => setTimeout(r, 150 * attempt));
              }
            }
            if (lastErr) throw lastErr;
          }
        } catch (setErr) {
          console.error('Final rejoin add failed for', user.uid, setErr && (setErr.code || setErr.message || setErr.toString()));
          throw setErr;
        }

        // Immediately mark presence for other clients: write lastSeen and clear disconnectedAt
        try {
          const now = Date.now();
          await set(ref(db, `rooms/${roomId}/participants/${user.uid}/lastSeen`), now);
          try {
            await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnected`), false);
          } catch (clearErr) {
            // ignore
          }
        } catch (e) {
          // small retry if immediate write failed
          setTimeout(async () => {
            try {
              const now2 = Date.now();
              await set(ref(db, `rooms/${roomId}/participants/${user.uid}/lastSeen`), now2);
              try {
                await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false);
              } catch (ee) { /* ignore */ }
            } catch (err) { /* ignore */ }
          }, 250);
        }

        // Aggressive clearing to beat any onDisconnect races: try immediate and delayed clears
        const ensureClear = async () => {
          try {
            await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false);
            await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedSession`), null);
          } catch (err) {
            // ignore
          }
        };
        ensureClear();
        setTimeout(ensureClear, 200);
        setTimeout(ensureClear, 800);

        // Cleanup: remove stale/duplicate participant entries
        const doCleanup = async () => {
          try {
            const partsSnap = await get(ref(db, `rooms/${roomId}/participants`));
            const parts = partsSnap && partsSnap.val() ? partsSnap.val() : {};
            const now3 = Date.now();
            const CLEAN_STALE_MS = 30 * 1000;
            for (const [otherUid, pdata] of Object.entries(parts)) {
              if (!pdata) continue;
              if (otherUid === user.uid) continue;
              const nameMatches = String(pdata.name || '').trim() === String(displayName || '').trim();
              const otherClient = pdata.clientId || null;

              if (otherClient && otherClient === clientId) {
                try { await remove(ref(db, `rooms/${roomId}/participants/${otherUid}`)); } catch (e) { /* ignore */ }
                continue;
              }

              if (nameMatches && pdata.disconnectedAt === true) {
                try { await remove(ref(db, `rooms/${roomId}/participants/${otherUid}`)); } catch (e) { /* ignore */ }
                continue;
              }

              if (nameMatches) {
                const otherLast = pdata.lastSeen || 0;
                const otherStale = otherLast && ((now3 - otherLast) > CLEAN_STALE_MS);
                if (!otherLast || otherStale) {
                  try { await remove(ref(db, `rooms/${roomId}/participants/${otherUid}`)); } catch (e) { /* ignore */ }
                }
              }
            }
          } catch (e) { /* ignore */ }
        };

        doCleanup();
        setTimeout(doCleanup, 500);
        setTimeout(doCleanup, 1500);

        // Transactional cleanup on root
        try {
          await runTransaction(roomRef, (current) => {
            if (!current) return current;
            if (!current.participants) current.participants = {};
            const parts = current.participants;
            const nowT = Date.now();
            const CLEAN_STALE_MS_T = 30 * 1000;

            const existing = parts[user.uid] || {};
            parts[user.uid] = Object.assign({}, existing, {
              name: String(displayName || existing.name || ''),
              clientId,
              lastSeen: nowT,
              disconnected: false,
              joinedAt: existing.joinedAt || nowT,
            });

            for (const otherUid of Object.keys(parts)) {
              if (otherUid === user.uid) continue;
              const pdata = parts[otherUid] || {};
              const otherClient = pdata.clientId || null;
              const nameMatches = String(pdata.name || '').trim() === String(displayName || '').trim();

              if (otherClient && otherClient === clientId) {
                delete parts[otherUid];
                continue;
              }

              if (nameMatches && pdata.disconnectedAt === true) {
                const otherDiscSess = pdata.disconnectedSession || null;
                if (!otherDiscSess || otherDiscSess !== sessionId) {
                  delete parts[otherUid];
                  continue;
                }
              }

              if (nameMatches) {
                const otherLast = pdata.lastSeen || 0;
                const otherStale = otherLast && ((nowT - otherLast) > CLEAN_STALE_MS_T);
                if (!otherLast || otherStale) delete parts[otherUid];
              }
            }

            current.participants = parts;
            return current;
          });
        } catch (e) { /* ignore */ }

        try {
          const hbId = setInterval(() => {
            set(ref(db, `rooms/${roomId}/participants/${user.uid}/lastSeen`), Date.now()).catch(()=>{});
          }, 15000);
          window.__scrumPokerHeartbeat = window.__scrumPokerHeartbeat || {};
          window.__scrumPokerHeartbeat[user.uid] = hbId;
        } catch(e) { /* ignore */ }
      } catch (e) {
        console.error('Failed to set participant entry on join:', e);
        throw e;
      }

    // Cancel any onDisconnect for participant.disconnected and disconnectedSession
    try {
      const discFlagPath = `rooms/${roomId}/participants/${user.uid}/disconnected`;
      const discSessPath = `rooms/${roomId}/participants/${user.uid}/disconnectedSession`;
      const discFlagRefCancel = ref(db, discFlagPath);
      const discSessRefCancel = ref(db, discSessPath);
      const od1 = onDisconnect(discFlagRefCancel);
      const od2 = onDisconnect(discSessRefCancel);
      try { if (od1 && typeof od1.cancel === 'function') od1.cancel(); } catch(e){}
      try { if (od2 && typeof od2.cancel === 'function') od2.cancel(); } catch(e){}
    } catch (e) {
      console.warn('Failed to cancel onDisconnect for participant.disconnected/disconnectedSession', e);
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
  set(pr, { name: displayName, vote: null, joinedAt: Date.now(), disconnectedAt: false }).catch((e) => console.error('Auto-rejoin failed', e));
      }
    } catch (e) {
      console.error('Auto-rejoin check failed', e);
    }
  }, [isOffline, user, joined, roomId, room, displayName]);

  // komponent içinde (örn. diğer handler'ların yanında) ekleyin:
  const handleReveal = async () => {
    if (!room) return
    if (isOffline) {
      setToastMessage('Cannot Reveal while offline');
      return;
    }
    try { await reveal() } catch (e) { console.error('handleReveal failed', e) }
  }

  // When we've successfully joined, aggressively clear disconnected flags so
  // we can observe presence state clearing on page load / rejoin.
  useEffect(() => {
    if (!joined || !user) return;
    (async () => {
      try {
        console.log('Post-join: clearing disconnectedAt/disconnectedSession for', user.uid);
        await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false);
        await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedSession`), null);
        console.log('Post-join: cleared disconnected flags for', user.uid);
      } catch (e) {
        console.warn('Post-join: failed to clear disconnected flags', e);
      }

      // retry a couple times to beat onDisconnect races
      setTimeout(async () => {
        try {
          await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false);
          await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedSession`), null);
          console.log('Post-join retry: cleared disconnected flags for', user.uid);
        } catch (e) { console.warn('Post-join retry failed', e) }
      }, 200);

      setTimeout(async () => {
        try {
          await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false);
          await set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedSession`), null);
          console.log('Post-join retry2: cleared disconnected flags for', user.uid);
        } catch (e) { console.warn('Post-join retry2 failed', e) }
      }, 800);
    })();
  }, [joined, user, roomId]);

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

  // Prevent page auto-scroll for non-moderator participants when moderator reveals results.
  // We capture the current scroll position before the DOM update and restore it right after
  // the reveal so the page doesn't jump for viewers who are not moderators.
  const _prevRoomState = useRef(room?.state);
  useEffect(() => {
    const prev = _prevRoomState.current;
    const curr = room?.state;
    if (prev !== curr) {
      if (curr === 'revealed' && user && !isModerator) {
        try {
          const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
          // restore after paint/layout — a tiny timeout to ensure DOM changes applied
          requestAnimationFrame(() => {
            setTimeout(() => {
              try { window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, scrollY); }
            }, 8);
          });
        } catch (e) { /* ignore */ }
      }
    }
    _prevRoomState.current = curr;
  }, [room?.state, isModerator, user]);

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
      <div className="theme-left">
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
      <div className="timer theme-timer">
        <span>{timer.hours.toString().padStart(2, '0')}:</span>
        <span>{timer.minutes.toString().padStart(2, '0')}:</span>
        <span>{timer.seconds.toString().padStart(2, '0')}</span>
      </div>
    </div>
      <div className="container">
        <div className="card p-3">
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
                  // reactivate if this user was reveal-offline
                  try { if (user && user.uid) { set(ref(db, `rooms/${roomId}/participants/${user.uid}/revealOffline`), null); set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false); } } catch(e){}
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
                  try { if (user && user.uid) { set(ref(db, `rooms/${roomId}/participants/${user.uid}/revealOffline`), null); set(ref(db, `rooms/${roomId}/participants/${user.uid}/disconnectedAt`), false); } } catch(e){}
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
                // determine offline: prefer recent lastSeen over disconnectedAt.
                // If lastSeen exists and is recent => online even if disconnectedAt was set earlier.
                // If lastSeen missing but disconnectedAt exists => consider offline.
                const OFFLINE_MS = 45 * 1000; // 45s threshold (heartbeat ~15s)
                const now = Date.now();
                const lastSeen = p.lastSeen || null;
                // accept either the new boolean flag or the old timestamp field
                const disconnectedFlag = (p.disconnectedAt === true) || null;
                let offline = false;
                // mark the current user as offline in their own view only if
                // their local browser reports offline (VPN/disconnect). This
                // allows moderators to see their own offline state and prevents
                // actions like Reveal/Reset when offline.
                if (isMe) {
                  offline = !!isOffline;
                } else if (lastSeen) {
                  // if lastSeen is present, use it as the source of truth
                  offline = (now - lastSeen) > OFFLINE_MS;
                } else if (disconnectedFlag) {
                  // no lastSeen, but explicit disconnected flag exists -> offline
                  offline = true;
                } else {
                  // no signals yet (very new participant) -> assume online
                  offline = false;
                }
                return (
                  <div
                    key={p.uid}
                    className={`participant-card poker ${voted ? 'voted' : 'not-voted'} ${isMe ? 'me' : ''} ${room?.owner === p.uid ? 'moderator' : ''} ${offline ? 'offline' : ''}`}
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
                      <div className={`p-status ${offline ? 'offline' : ''}`}>
                        {offline ? (
                          <span className="offline-badge" title="Offline">
                            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden xmlns="http://www.w3.org/2000/svg">
                              <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2.05 6.39a16 16 0 0119.9 0" />
                                <path d="M4.93 9.27a11 11 0 0114.14 0" />
                                <path d="M7.76 12.1a6 6 0 018.48 0" />
                                <path d="M3 3l18 18" />
                              </g>
                            </svg>
                            <span style={{ marginLeft: 8 }}>Offline</span>
                          </span>
                        ) : (
                          (voted ? '👍 Voted' : '⏳ Waiting')
                        )}
                      </div>
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
                  <button className="btn-circle" onClick={handleReveal} disabled={isOffline || !!room?.markedForDeletionAt}>
                    <img src="/reveal-icon.svg" alt="Reveal" className="icon" />
                  </button>
                  <div className="button-label">Reveal</div>
                </div>
              )}
              {isModerator && room.state === 'revealed' && (
                <div className="button-container">
                  <button className="btn-circle" onClick={reset} disabled={isOffline || !!room?.markedForDeletionAt}>
                    <img src="/reset-icon.svg" alt="Reset" className="icon" />
                  </button>
                  <div className="button-label">Restart</div>
                </div>
              )}
            </div>
            <div className="results">
              <div className="small" style={{ marginBottom: 8 }}>Results</div>
              <div className="row">
                {room.state === 'revealed' && averageVote ? (
                  <div className="participant" style={{ flex: '1 1 40px' }}>
                    <div>Average: {averageVote.avg}</div>
                    <div style={{ fontWeight: 500 }}>Rounded: {averageVote.rounded}</div>
                  </div>
                ) : (
                  // Reserve the same space for non-moderator participants so the
                  // "Choose your card" area doesn't shift when results appear.
                  (!isModerator ? (
                    <div className="participant placeholder" aria-hidden="true" style={{ flex: '1 1 40px' }} />
                  ) : null)
                )}
              </div>
            </div>
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