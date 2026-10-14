import { useT } from './i18n/I18nProvider';
import { Endpoints } from './sections/Endpoints';
import { Features } from './sections/Features';
import { Footer } from './sections/Footer';
import { Header } from './sections/Header';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Performance } from './sections/Performance';
import { Quickstart } from './sections/Quickstart';
import { Why } from './sections/Why';

export function App() {
  const t = useT();
  return (
    <>
      <a className="skip-link" href="#main">
        {t('nav.skip')}
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Why />
        <HowItWorks />
        <Features />
        <Endpoints />
        <Performance />
        <Quickstart />
      </main>
      <Footer />
    </>
  );
}
