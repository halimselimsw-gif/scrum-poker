import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ref, onValue, set, update, get, remove, onDisconnect, off, runTransaction } from 'firebase/database'
import { db, ensureAuth } from './firebase'
import './room.css'
const CARDS = ['0','1/2','1','2','3','5','8','13','20','40','100','?','♾']

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
  const navigate = useNavigate()
  const roomRef = useMemo(() => ref(db, `rooms/${roomId}`), [roomId])
  const pRef = useMemo(() => user ? ref(db, `rooms/${roomId}/participants/${user.uid}`) : null, [roomId, user])

  // moderator mu?
  const isModerator = useMemo(() => !!(user && room && room.owner === user.uid), [user, room])

  useEffect(() => {
    ensureAuth().then(u => setUser(u))
  }, [])

  // Odaya bağlan ve realtime dinle (sadece dinleme burada; "katıl" işlemi ayrı)
  useEffect(() => {
    if (!user) return

    const onValueCallback = (snap) => {
      const data = snap.val()
      setRoom(data)
      const currentVote = data?.participants?.[user.uid]?.vote ?? null
      setMyVote(currentVote)
      setLoading(false)

      // eğer participant zaten DB'de varsa joined=true (yeniden yükleme/bağlanma)
      if (data?.participants?.[user.uid]) {
        setJoined(true)
      }

      // eğer moderator tarafından atıldıysa (rooms/.../kicks/{uid} işareti)
      if (data?.kicks?.[user.uid]) {
        // temizleme isteği gönder (opsiyonel) ve client'ı odadan çıkart
        try { remove(ref(db, `rooms/${roomId}/kicks/${user.uid}`)) } catch(e) {}
        // onLeave parent'i çağırarak UI'dan çıkart ve oluşturma sayfasına yönlendir
        setTimeout(() => {
          onLeave()
          navigate('/') // ana sayfaya yönlendir
        }, 50)
      }
    }

    const unloadHandler = () => {
      // yalnızca gerçekten katıldıysa kaydı sil
      try { if (pRef && joined) remove(pRef) } catch (e) {}
    }

    let mounted = true
    ;(async () => {
      const snap = await get(roomRef)
      // atomik olarak oda yoksa oluştur ve owner yoksa ata (race koşulunu önler)
      await runTransaction(roomRef, (current) => {
        if (current == null) {
          return {
            createdAt: Date.now(),
            state: 'voting',
            story: '',
            participants: {},
            owner: user.uid
          }
        }
        if (!current.owner) {
          current.owner = user.uid
        }
        return current
      })

      // sadece dinleyici kuruyoruz; katılma (participant oluşturma) kullanıcı onayına kalacak
      window.addEventListener('beforeunload', unloadHandler)
      onValue(roomRef, onValueCallback)
    })()

    return () => {
      if (!mounted) return
      mounted = false
      // sadece katıldıysa temizle
      try { if (pRef && joined) remove(pRef) } catch (e) {}
      window.removeEventListener('beforeunload', unloadHandler)
      off(roomRef, 'value', onValueCallback)
    }
  }, [user, roomId])

  // Oy kullan — oylama açıkken değiştirebilir, reveal sonrası değiştiremez
  const castVote = async (value) => {
    if (!user || !room || room.state !== 'voting') return
    setMyVote(value)
    await update(ref(db, `rooms/${roomId}/participants/${user.uid}`), { vote: value })
  }

  const reveal = async () => update(roomRef, { state: 'revealed' })
  const reset = async () => {
    const updates = {}
    Object.keys(room?.participants || {}).forEach(uid => { updates [`participants/${uid}/vote`] = null })
    updates ['state'] = 'voting'
    await update(roomRef, updates)
    setMyVote(null)
  }
  const setStory = async (story) => update(roomRef, { story })

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
    try {
      // öncelikle kicks flag koy, böylece hedef kullanıcının client'ı hemen ayrılacak
      await set(ref(db, `rooms/${roomId}/kicks/${uid}`), true)
      // kısa bekleme, ardından serverdan participant node'u kaldır
      setTimeout(async () => {
        try { await remove(ref(db, `rooms/${roomId}/participants/${uid}`)) } catch(e) {}
      }, 200)
    } catch (err) {
      console.error('Kick failed', err)
    }
  }

  // Moderator ayrılırsa/bağlantısı koparsa oda tamamen silinsin
  useEffect(() => {
    if (!isModerator) return
    try { onDisconnect(roomRef).remove() } catch (e) {}
    const modUnload = () => { try { remove(roomRef) } catch (e) {} }
    window.addEventListener('beforeunload', modUnload)

    return () => {
      window.removeEventListener('beforeunload', modUnload)
      try { onDisconnect(roomRef).cancel && onDisconnect(roomRef).cancel() } catch (e) {}
    }
  }, [isModerator, roomRef])

  // displayName değiştiğinde hem localStorage'e kaydet hem DB'yi güncelle (eğer user varsa)
  useEffect(() => {
    try { localStorage.setItem('scrum-poker-name', displayName) } catch(e){}
    if (!user) return
    const pRef = ref(db, `rooms/${roomId}/participants/${user.uid}`)
    update(pRef, { name: displayName }).catch(()=>{})
  }, [displayName, user, roomId])

  // kullanıcı "Katıl" butonuna basınca participant olarak kayıt ol
  const joinRoom = async () => {
    if (!user) return
    try {
      await update(pRef, {
        name: displayName,
        vote: null,
        joinedAt: Date.now()
      })

      // atomik owner ataması: eğer owner yoksa bu client owner olur
      try {
        await runTransaction(roomRef, (current) => {
          if (!current) {
            return {
              createdAt: Date.now(),
              state: 'voting',
              story: '',
              participants: {},
              owner: user.uid
            }
          }
          if (!current.owner) current.owner = user.uid
          return current
        })
      } catch (e) {
        console.warn('owner tx ignored', e)
      }

      try { onDisconnect(pRef).remove() } catch (e) {}
      try { localStorage.setItem('scrum-poker-name', displayName) } catch(e){}
      setJoined(true)
    } catch (e) {
      console.error('Join failed', e)
    }
  }

  // komponent içinde (örn. diğer handler'ların yanında) ekleyin:
  const handleReveal = async () => {
    if (!room) return
    try { await update(roomRef, { state: 'revealed' }) } catch (e) { console.error(e) }
  }

  // Deal animation: ilk katılımda (joined true) kartları dağıt
  useEffect(() => {
    if (!dealt && joined) {
      // küçük gecikme ile başlat
      const t = setTimeout(() => setDealt(true), 120)
      // animasyon bittikten sonra sınıfı temizle (yeniden tetiklemeye izin için)
      const t2 = setTimeout(() => setDealt(false), 2200)
      return () => { clearTimeout(t); clearTimeout(t2) }
    }
  }, [joined, dealt])

  if(loading) return <div className="container"><div className="card">Loading room…</div></div>

  return (
    <div className="container">
      <div className="card">
        <div className="header">
          <div>
            <div className="small">Room</div>
            <div className="copy" style={{fontSize:20}}>{roomId}</div>

           <div style={{height:8}} />
           <div className="small">Host</div>
           <div style={{padding:'8px 0'}}>
             {/* show only moderator (owner) name here */}
             <div style={{fontSize:14, fontWeight:700}}>
               {room?.owner ? (room?.participants?.[room.owner]?.name || room.owner) : '—'}
             </div>
           </div>
          </div>

          <div className="footer">
            <button className="btn" onClick={() => { navigator.clipboard.writeText(roomId) }}>Copy Code</button>
            <button
              className="btn"
              onClick={async () => {
                try {
                  if (isModerator) {
                    await remove(roomRef)
                  } else {
                    await remove(ref(db, `rooms/${roomId}/participants/${user.uid}`))
                  }
                } catch (e) { console.error(e) }
                onLeave()
                navigate('/') // navigate to home
              }}
            >
              Leave
            </button>
          </div>
        </div>

        <div className="row" style={{alignItems:'center', justifyContent:'space-between'}}>
          <input className="input" placeholder="Story title (optional)" value={room?.story || ''} onChange={e=> setStory(e.target.value)} />
          <span className="badge">Status: {room?.state === 'voting' ? 'Voting' : 'Revealed'}</span>
        </div>

        <div style={{height:16}}/>
        <div>
          <div className="small" style={{marginBottom:8}}>Participants</div>
          <div className="row">
            {participants.map(p => {
              const voted = !!p.vote
              const isMe = user && p.uid === user.uid
              const AVATAR = avatarFor(p.uid)
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
                      <div className="card-value">
                        {/* show actual vote only after reveal */}
                        { room?.state === 'revealed' ? (p.vote || '-') : '' }
                      </div>
                    </div>
                  </div>
                   <div className="p-info">
                     <div className="p-name">
                       {p.name || 'Anonymous'}
                       {isMe && <span className="me-badge" aria-hidden> You</span>}
                     </div>
                    <div className="p-status">{voted ? '✅ Voted' : '⏳ Waiting'}</div>
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

        <div style={{height:20}}/>
        <div>
          <div className="small" style={{marginBottom:8}}>Choose your card</div>
          <div className="grid">
            {CARDS.map((c, i) => {
              // small alternating start rotation for nicer spread
              const startRot = (i % 2 === 0) ? -8 : 8
              return (
                <button
                  key={c}
                  className={`cardBtn poker ${myVote===c ? 'active':''} ${dealt ? 'dealt' : ''}`}
                  onClick={()=>castVote(c)}
                  disabled={room?.state !== 'voting'}
                  aria-pressed={myVote===c}
                  style={dealt ? { animationDelay: `${i * 70}ms`, ['--start-rot']: `${startRot}deg` } : undefined}
                >
                 <div className="poker-top">{c}</div>
                </button>
              )
            })}
           </div>
        </div>

        <div style={{height:16}}/>
        <div className="footer">
          {isModerator && room.state === 'voting' && (
            <button className="btn primary" onClick={handleReveal}>Reveal</button>
          )}
          {isModerator && room.state === 'revealed' && (
            <button className="btn" onClick={reset}>Reset</button>
          )}
          <span className="small">{allVoted ? 'Everyone voted.' : 'Waiting for votes…'}</span>
        </div>

        {room.state === 'revealed' && (
          <div style={{marginTop:16}}>
            <div className="small" style={{marginBottom:8}}>Results</div>
            <div className="row">
              {averageVote && (
                <div className="participant" style={{flex:'1 1 140px'}}>
                  <div>Average: {averageVote.avg}</div>
                  <div style={{fontWeight:700}}>Rounded: {averageVote.rounded}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
