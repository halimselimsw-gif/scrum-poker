import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App'
// Import Bootstrap CSS (installed via npm)
import 'bootstrap/dist/css/bootstrap.min.css'
import './styles.css'

// Build timestamp for deployed bundles — helps verify cache/stale bundle issues in production.
console.log('scrum-poker build:', {
  time: new Date().toISOString(),
  env: process.env.NODE_ENV || 'development'
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/room/:roomId" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
