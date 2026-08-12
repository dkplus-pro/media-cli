const highlights = [
  "Modern.js React app shell",
  "Application-local type-check, lint, and test scripts",
  "Ready to compose with shared packages from the monorepo"
];

export default function HomePage() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="eyebrow">Turborepo + pnpm template</p>
      <h1 id="hero-title">Hello from the demo app.</h1>
      <p className="lede">
        Use this application as the first runnable workspace while packages, CI, and deployment
        support are added around it.
      </p>
      <ul className="highlights" aria-label="Demo app capabilities">
        {highlights.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
