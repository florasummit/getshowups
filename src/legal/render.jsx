// Build-time only (vite.config.js): the privacy policy as HTML.
import { renderToStaticMarkup } from 'react-dom/server'
import Privacy from './Privacy.jsx'

export const renderPrivacy = () => renderToStaticMarkup(<Privacy />)
