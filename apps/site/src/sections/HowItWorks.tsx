import { Pipeline } from '../components/Pipeline';
import { Reveal } from '../components/Reveal';
import { useT } from '../i18n/I18nProvider';
import { SectionHead } from './SectionHead';

export function HowItWorks() {
  const t = useT();
  return (
    <section className="section section-alt" id="how">
      <div className="container">
        <SectionHead index="02" label={t('pipeline.label')} title={t('pipeline.title')} lead={t('pipeline.lead')} />
        <Reveal>
          <Pipeline />
        </Reveal>
      </div>
    </section>
  );
}
