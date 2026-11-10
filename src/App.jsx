import Header from './components/Header.jsx'
import Hero from './components/Hero.jsx'
import HowItWorks from './components/HowItWorks.jsx'
import Features from './components/Features.jsx'
import Pricing from './components/Pricing.jsx'
import BookDemo from './components/BookDemo.jsx'
import Faq from './components/Faq.jsx'
import Footer from './components/Footer.jsx'

export default function App() {
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
        <Pricing />
        <BookDemo />
        <Faq />
      </main>
      <Footer />
    </>
  )
}
