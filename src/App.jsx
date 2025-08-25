import React, { useEffect, useMemo, useState } from 'react'
import Room from './Room'
import { ref, runTransaction } from 'firebase/database'
import { db, ensureAuth } from './firebase'

const DEFAULT_NAMES = ['Frodo','Samwise','Gandalf','Aragorn','Legolas','Gimli','Boromir','Merry','Pippin','Elrond','Galadriel', 'Sabri','Bilbo']

const randomRoom = () => Math.random().toString(36).slice(2, 8).toUpperCase()


export default function App(){
   const [user, setUser] = useState(null)
   const [mode, setMode] = useState('home')
   const [roomId, setRoomId] = useState('')


// name: default LOTR karakteri veya localStorage'daki kayıt; editable on the join screen
const [name, setName] = useState(() => {
try {
const cached = localStorage.getItem('scrum-poker-name')
if (cached && cached.trim().length) return cached
} catch (e) {}
const idx = Math.floor(Math.random() * DEFAULT_NAMES.length)
return DEFAULT_NAMES[idx]
})


useEffect(() => {
ensureAuth().then(setUser)
}, [])

// persist name to localStorage whenever user edits it on the home/join screen
useEffect(() => {
try { localStorage.setItem('scrum-poker-name', name) } catch(e){}
  try { localStorage.setItem('scrum-poker-mode', mode) } catch(e) {}

}, [name])


const canJoin = useMemo(() => name.trim().length >= 2 && roomId.trim().length >= 4, [name, roomId])


const [theme, setTheme] = useState(() => {
  try {
    const savedTheme = localStorage.getItem('scrum-poker-theme');
    return savedTheme || 'light';
  } catch (e) {
    return 'light';
  }
});

useEffect(() => {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('scrum-poker-theme', theme);
  } catch (e) {
    console.error('Failed to save theme to localStorage', e);
  }
}, [theme]);

const toggleTheme = () => {
  setTheme((prevTheme) => (prevTheme === 'dark' ? 'light' : 'dark'));
};


if(!user) return <div className="container"><div className="card">Signing in…</div></div>
/*
if (mode === 'room') {
  return <Room roomId={roomId} name={name} onLeave={() => { setMode('home'); setRoomId(''); }} />;
}*/

if (mode === 'room' && roomId) {
  return <Room roomId={roomId} name={name} onLeave={() => { 
    setMode('home'); 
    setRoomId('');
  }} />;
}

return (
    <div className="container">
      <div className="card">
        <div className="header">
          <h1>Scrum Poker</h1>
          <span className="badge"> · R-time</span>
          <button className="btn" onClick={toggleTheme}>
    Switch to {theme === 'light' ? 'Dark' : 'Light'} Mode
  </button>
        </div>
        <p className="kicker">Create a room, invite your team and estimate story points.</p>

        <div style={{height:12}} />
        <div className="row">
          <input
            className="input"
            placeholder="Your name"
            value={name}
            onChange={e=>setName(e.target.value)}
          />
        </div>
        <div style={{height:12}} />
        <div className="row">
          <input className="input" placeholder="Room code (e.g. ABC123)" value={roomId} onChange={e=>setRoomId(e.target.value.toUpperCase())} />
        </div>
        <div style={{height:12}} />
        <div className="row">
          <button className="btn" onClick={() => setRoomId(randomRoom())}>Random Code</button>
          <button
            className="btn primary"
            disabled={!canJoin}
            onClick={async () => {
              // ensure user is authenticated and use the returned uid inside the transaction
              const u = user || await ensureAuth()
              setUser(u)
              const rRef = ref(db, `rooms/${roomId}`)
              try {
                await runTransaction(rRef, (current) => {
                  if (current == null) {
                    return {
                      createdAt: Date.now(),
                      state: 'voting',
                      story: '',
                      participants: {},
                      owner: u.uid
                    }
                  }
                  if (!current.owner) current.owner = u.uid
                  return current
                })
              } catch (e) {
                console.error('create room tx failed', e)
              }
              setMode('room')
            }}
          >
            {'Join / Create Room'}
          </button>
        </div>

        <div style={{height:16}}/>
        <div className="small">The first person in the room is the moderator and can Reveal/Reset.</div>
      </div>
    </div>
  )
}
