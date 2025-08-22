import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth'


// 🔁 Burayı kendi Firebase web uygulaması config’inizle doldurun
const firebaseConfig = {
apiKey: "AIzaSyBLp4z5V1ymv8PGSFeUyukhEKSRwciGAvM",
authDomain: "test-faa43.firebaseapp.com",
databaseURL: "https://test-faa43-default-rtdb.firebaseio.com",
projectId: "test-faa43",
storageBucket: "test-faa43.firebasestorage.app",
messagingSenderId: "604707384066",
appId: "1:604707384066:web:bc65a59c6fb6afa21ef01b"
}


const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)
export const auth = getAuth(app)


export const ensureAuth = () => new Promise((resolve, reject) => {
onAuthStateChanged(auth, (user) => {
if (user) return resolve(user)
signInAnonymously(auth).then(() => resolve(auth.currentUser)).catch(reject)
})
})