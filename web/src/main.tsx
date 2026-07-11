import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './context/AuthContext'
import { PermissionsProvider } from './context/PermissionsContext'
import { ExplorationProvider } from './context/ExplorationContext'
import { ModalProvider } from './context/ModalContext'
import { pruneAllCaches } from './lib/storage'

// Housekeeping: expire stale cache entries and drop legacy keys before the app
// starts, so localStorage can never fill up and break real writes (progress).
pruneAllCaches()

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      })

      // Check for updates
      setInterval(() => {
        registration.update().catch(err => console.error('SW update error:', err))
      }, 60000) // Check every 60 seconds
    } catch (error) {
      console.error('Service Worker registration failed:', error)
    }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <PermissionsProvider>
        <ExplorationProvider>
          <ModalProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ModalProvider>
        </ExplorationProvider>
      </PermissionsProvider>
    </AuthProvider>
  </StrictMode>,
)
