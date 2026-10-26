import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

document.body.dataset.platform = window.api.platform
createRoot(document.getElementById('root')!).render(<App />)
