import { useT } from './i18n/I18nProvider';
import { Endpoints } from './sections/Endpoints';
import { Features } from './sections/Features';
import { Footer } from './sections/Footer';
import { GenerativeUi } from './sections/GenerativeUi';
import { Header } from './sections/Header';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Performance } from './sections/Performance';
import { Pillars } from './sections/Pillars';
import { Problem } from './sections/Problem';
import { Quickstart } from './sections/Quickstart';
import { Servers } from './sections/Servers';
import { Sources } from './sections/Sources';

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
        <Problem />
        <Pillars />
        <Servers />
        <GenerativeUi />
        <HowItWorks />
        <Sources />
        <Features />
        <Endpoints />
        <Performance />
        <Quickstart />
      </main>
      <Footer />
    </>
  );
}
