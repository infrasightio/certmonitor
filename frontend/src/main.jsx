import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { AlertCountProvider } from './hooks/useAlertCount'
import { AuthProvider } from './hooks/useAuth'
import { BrandingProvider } from './hooks/useBranding'
import { FeaturesProvider } from './hooks/useFeatures'
import { ToastProvider } from './hooks/useToast'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <BrandingProvider>
          <AuthProvider>
            <FeaturesProvider>
              {/* Inside auth: the count is per-user and needs a token. */}
              <AlertCountProvider>
                <App />
              </AlertCountProvider>
            </FeaturesProvider>
          </AuthProvider>
        </BrandingProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
