import { useEffect } from 'react'
import Header from './components/Header.jsx'
import Hero from './components/Hero.jsx'
import HowItWorks from './components/HowItWorks.jsx'
import Features from './components/Features.jsx'
import Simulation from './components/Simulation.jsx'
import Pricing from './components/Pricing.jsx'
import BookDemo from './components/BookDemo.jsx'
import Faq from './components/Faq.jsx'
import Footer from './components/Footer.jsx'

export default function App() {
  // Arriving from another page at /#section (e.g. "Book a call" on the closed sign-up screen): the browser's own
  // fragment scroll runs before React renders the section, so scroll once after the first render.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (/^[a-z][a-z0-9-]{0,40}$/.test(id)) document.getElementById(id)?.scrollIntoView()
  }, [])
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <HowItWorks />
        <Features />
        <Simulation />
        <Pricing />
        <BookDemo />
        <Faq />
      </main>
      <Footer />
    </>
  )
}
