import React, { useEffect, useMemo, useState } from 'react'
import Room from './Room'
import { ref, runTransaction, update } from 'firebase/database'
import { db, ensureAuth } from './firebase'

const DEFAULT_NAMES = ['Frodo','Samwise','Gandalf','Aragorn','Legolas','Gimli','Boromir','Merry','Pippin','Elrond','Galadriel', 'Sabri','Bilbo']

const randomRoom = () => Math.random().toString(36).slice(2, 8).toUpperCase()


export default function App(){
  // Helper: run a transaction with retries to reduce transient failures
  const runTransactionWithRetry = async (rRef, updater, attempts = 3, baseDelay = 150) => {
    for (let i = 0; i < attempts; i++) {
      try {
        await runTransaction(rRef, updater);
        return true;
      } catch (e) {
        console.error('runTransactionWithRetry attempt', i + 1, 'failed for', rRef && rRef.path ? rRef.path.toString() : rRef, e && (e.message || e.toString()));
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
      }
    }
    return false;
  };

  const getWithRetry = async (rRef, attempts = 4, baseDelay = 150) => {
    for (let i = 0; i < attempts; i++) {
      try {
        const { get } = await import('firebase/database');
        const snap = await get(rRef);
        return snap;
      } catch (e) {
        console.error('getWithRetry attempt', i + 1, 'failed for', rRef && rRef.path ? rRef.path.toString() : rRef, e && (e.message || e.toString()));
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
      }
    }
    return null;
  };
   const [user, setUser] = useState(null)
   const [mode, setMode] = useState('home')
   const [roomId, setRoomId] = useState(() => {
  let initialRoomId = '';

  // Query parametrelerinden kontrol et
  const urlParams = new URLSearchParams(window.location.search);
  initialRoomId = urlParams.get('roomId');

  // Eğer query parametrelerinde yoksa hash'ten kontrol et
  if (!initialRoomId) {
    const hashParams = new URLSearchParams(window.location.hash.replace('#', '?'));
    initialRoomId = hashParams.get('roomId');
  }

  // Eğer pathname'den alınması gerekiyorsa kontrol et
  if (!initialRoomId) {
    const pathSegments = window.location.pathname.split('/');
    if (pathSegments[1] === 'room') {
      initialRoomId = pathSegments[2];
    }
  }

  return initialRoomId || '';
})


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
  // Temporarily disable CSS transitions to make the theme flip feel instantaneous
  try {
    document.documentElement.classList.add('disable-transitions');
  } catch (e) {}
  setTheme((prevTheme) => (prevTheme === 'dark' ? 'light' : 'dark'));
  // Re-enable transitions shortly after
  setTimeout(() => {
    try { document.documentElement.classList.remove('disable-transitions'); } catch (e) {}
  }, 60);
};

  // helper for theme-aware button styles
  const themeBtnClass = (variant = 'secondary') => {
    if (theme === 'dark') return `btn btn-outline-light`;
    if (variant === 'primary') return 'btn btn-primary';
    if (variant === 'info') return 'btn btn-outline-info';
    return 'btn btn-outline-secondary';
  }


useEffect(() => {
  const urlParams = new URLSearchParams(window.location.search);
  let roomIdFromUrl = urlParams.get('roomId');

  if (!roomIdFromUrl) {
    const pathSegments = window.location.pathname.split('/');
    if (pathSegments[1] === 'room') {
      roomIdFromUrl = pathSegments[2];
    }
  }

  if (roomIdFromUrl) {
    setRoomId(roomIdFromUrl);
  }
}, []);

useEffect(() => {
    const getWithRetry = async (rRef, attempts = 4, baseDelay = 150) => {
      for (let i = 0; i < attempts; i++) {
        try {
          const { get } = await import('firebase/database');
          const snap = await get(rRef);
          return snap;
        } catch (e) {
          console.error('getWithRetry attempt', i + 1, 'failed for', rRef && rRef.path ? rRef.path.toString() : rRef, e && (e.message || e.toString()));
          await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
        }
      }
      return null;
    };

    const runTransactionWithRetry = async (rRef, updater, attempts = 3, baseDelay = 150) => {
      for (let i = 0; i < attempts; i++) {
        try {
          await runTransaction(rRef, updater);
          return true;
        } catch (e) {
          console.error('runTransactionWithRetry attempt', i + 1, 'failed for', rRef && rRef.path ? rRef.path.toString() : rRef, e && (e.message || e.toString()));
          await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
        }
      }
      return false;
    };

    const updateRoomState = async () => {
      const rRef = ref(db, `rooms/${roomId}`);
      try {
        const snap = await getWithRetry(rRef);
        if (!snap || !snap.exists()) {
          console.warn('updateRoomState: room not found, skipping initial state set for', roomId);
          return;
        }

        // Try a narrow transaction on the child 'state' first to reduce conflicts
        try {
          const stateRef = ref(db, `rooms/${roomId}/state`);
          const ok = await runTransactionWithRetry(stateRef, (current) => {
            if (current == null) return 'voting';
            return current;
          });
          if (ok) return;
          console.warn('Narrow state transaction failed, falling back to root transaction for', roomId);
        } catch (narrowErr) {
          console.error('Narrow state transaction threw an error:', narrowErr && (narrowErr.message || narrowErr.toString()), { roomId, stack: narrowErr && narrowErr.stack });
        }

        await runTransactionWithRetry(rRef, (current) => {
          if (current && !current.state) {
            return { ...current, state: 'voting' };
          }
          return current;
        });
      } catch (e) {
        console.error('Failed to update room state:', e && (e.message || e.toString()), {
          roomId,
          stack: e && e.stack
        });
      }
    };

    if (roomId) {
      updateRoomState();
    }
}, [roomId]);

const updateRoomState = async (newState) => {
  try {
    if (!roomId) {
      console.warn('updateRoomState called without roomId, skipping');
      return;
    }
    const rRef = ref(db, `rooms/${roomId}`);
    console.log('Running transaction to set room state ->', newState, 'for', roomId);
    const ok = await runTransactionWithRetry(rRef, (current) => {
      if (!current) return current;
      current.state = newState;
      return current;
    });
    if (!ok) {
      console.warn('runTransactionWithRetry failed, attempting narrow fallback set/update for state');
      try {
        // Try a narrow update to the child 'state' to avoid root transaction issues
        const { set } = await import('firebase/database');
        const stateRef = ref(db, `rooms/${roomId}/state`);
        // ensure the node exists before set
        const { get } = await import('firebase/database');
        const snap = await get(ref(db, `rooms/${roomId}`));
        if (snap && snap.exists()) {
          try {
            await set(stateRef, newState);
            console.log('Fallback set of rooms/<roomId>/state succeeded');
          } catch (e) {
            console.warn('Fallback set failed, trying update on parent', e && (e.message || e.toString()));
            try { await update(ref(db, `rooms/${roomId}`), { state: newState }); console.log('Fallback update succeeded'); } catch (e2) { throw e2; }
          }
        } else {
          console.warn('Fallback skipped: room does not exist during fallback set/update for', roomId);
        }
      } catch (fallbackErr) {
        console.error('Fallback write for room state also failed:', fallbackErr && (fallbackErr.message || fallbackErr.toString()), { roomId, newState, stack: fallbackErr && fallbackErr.stack });
      }
    }
    console.log('Room state transaction completed:', newState);
  } catch (error) {
    console.error('Failed to update room state via transaction:', error && (error.message || error.toString()), {
      roomId,
      newState,
      stack: error && error.stack
    });
  }
};

if (roomId && mode === 'home') {
  return (
    <div className="container">
      <div className="card">
        <h2>Room Invitation</h2>
        <p>You have been invited to join room: <strong>{roomId}</strong></p>
        <div className="row" style={{ marginBottom: '12px' }}>
          <input
            className="input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '100%', color: 'black' }}
          />
        </div>
        <div className="row" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button className={themeBtnClass('primary')} onClick={() => setMode('room')} style={{ flex: 1, marginRight: '8px' }}>
            Join Room
          </button>
          <button className={themeBtnClass()} onClick={() => setRoomId('')} style={{ flex: 1 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

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
          <button className={themeBtnClass()} onClick={toggleTheme}>
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
            style={{ color: 'black' }}
          />
        </div>
        <div style={{height:12}} />
        <div className="row">
          <input className="input" placeholder="Room code (e.g. ABC123)" value={roomId} onChange={e=>setRoomId(e.target.value.toUpperCase())} style={{ color: 'black' }} />
        </div>
        <div style={{height:12}} />
  <div className="row">
    <button
  className={themeBtnClass('primary')}
  onClick={async () => {
    const newRoomId = randomRoom();
    setRoomId(newRoomId);

    // Ensure user is authenticated
    const u = user || await ensureAuth();
    setUser(u);

    // Create the room and assign the moderator
    const rRef = ref(db, `rooms/${newRoomId}`);
    try {
      await runTransaction(rRef, (current) => {
        if (current == null) {
          return {
            createdAt: Date.now(),
            state: 'voting',
            story: '',
            participants: {},
            owner: u.uid,
          };
        }
        if (!current.owner) current.owner = u.uid;
        return current;
      });
    } catch (e) {
      console.error('Failed to create room:', e);
    }
  }}
>
  Random Code
</button>
          <button
            className={themeBtnClass('primary')}
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
