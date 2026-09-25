import Link from "next/link";
import PageShell from "@/components/PageShell";
import Button from "@/components/Button";
import Card from "@/components/Card";
import AlertBanner from "@/components/AlertBanner";
import Equalizer from "@/components/Equalizer";
import { ClockIcon, HeadphonesIcon, ShieldIcon } from "@/components/Icons";

export default function Home() {
  return (
    <PageShell>
      <section className="hero hero--split">
        <div>
          <p className="hero__eyebrow">Subjective speech evaluation</p>
          <h1 className="hero__title">Dengar helps you rate speech quality with confidence.</h1>
          <p className="hero__copy">
            Answer simple questions about spoken audio using headphones, within a short guided
            session. Your participation is private, and designed to be clear for anyone.
          </p>
          <div className="hero__actions">
            <Link href="/get-started">
              <Button type="button">Get started</Button>
            </Link>
            <Link href="#info">
              <Button variant="secondary" type="button">Learn more</Button>
            </Link>
          </div>
          <ul className="chip-list">
            <li className="chip">Runs fully offline</li>
            <li className="chip">No account needed</li>
            <li className="chip">Under 10 minutes</li>
          </ul>
        </div>

        <div className="preview-card" aria-label="Session preview">
          <div className="preview-card__header">
            <span>Session preview</span>
            <span className="preview-card__badge">MOS</span>
          </div>
          <div className="preview-card__wave">
            <Equalizer />
          </div>
          <p className="preview-card__question">How natural does this voice sound to you?</p>
          <div className="mos-scale" aria-hidden="true">
            <span className="mos-scale__dot">1</span>
            <span className="mos-scale__dot">2</span>
            <span className="mos-scale__dot">3</span>
            <span className="mos-scale__dot mos-scale__dot--active">4</span>
            <span className="mos-scale__dot">5</span>
          </div>
          <p className="preview-card__caption">
            Example of the simple 1 to 5 scale you will use. No audio plays on this page.
          </p>
        </div>
      </section>

      <AlertBanner
        title="Designed for private, offline studies"
        description="Dengar uses only local UI assets in this milestone."
      />

      <section id="how" className="section" aria-labelledby="how-heading">
        <h2 id="how-heading" className="section-heading">How it works</h2>
        <p className="section-sub">Three simple steps. No technical background needed.</p>
        <ol className="step-list">
          <li className="step">
            <p className="step__title">Put on headphones</p>
            <p className="step__desc">Find a quiet spot and use headphones for consistent listening.</p>
          </li>
          <li className="step">
            <p className="step__title">Listen to short clips</p>
            <p className="step__desc">Each clip plays once or twice, depending on the task.</p>
          </li>
          <li className="step">
            <p className="step__title">Rate what you hear</p>
            <p className="step__desc">Score each clip on a simple scale. There are no wrong answers.</p>
          </li>
        </ol>
      </section>

      <section className="section" aria-label="What to expect">
        <h2 className="section-heading">What to expect</h2>
        <p className="section-sub">
          The session uses MOS and SUS concepts in a general way, so it stays friendly and easy
          to understand.
        </p>
        <div className="section-grid section-grid--cols-2">
          <Card title="MOS rating">
            <p>
              Rate naturalness and clarity on a straightforward numeric scale, from bad to
              excellent.
            </p>
          </Card>
          <Card title="SUS preview">
            <p>
              Listen to short sentences and judge intelligibility without bias.
            </p>
          </Card>
        </div>
      </section>

      <section id="info" className="section" aria-labelledby="info-heading">
        <h2 id="info-heading" className="section-heading">Practical information</h2>
        <p className="section-sub">A few things worth knowing before you start.</p>
        <ul className="info-list info-list--cols">
          <li className="info-list__item">
            <span className="info-list__icon"><HeadphonesIcon /></span>
            <div>
              <p className="info-list__title">Headphones recommended</p>
              <p className="info-list__desc">
                Use headphones for the best audio experience and clear rating results.
              </p>
            </div>
          </li>
          <li className="info-list__item">
            <span className="info-list__icon"><ClockIcon /></span>
            <div>
              <p className="info-list__title">Session duration</p>
              <p className="info-list__desc">
                Most sessions take under 10 minutes for the first set of ratings.
              </p>
            </div>
          </li>
          <li className="info-list__item">
            <span className="info-list__icon"><ShieldIcon /></span>
            <div>
              <p className="info-list__title">Confidentiality</p>
              <p className="info-list__desc">
                Your responses are stored privately and no personal identity is collected.
              </p>
            </div>
          </li>
        </ul>
      </section>
    </PageShell>
  );
}
