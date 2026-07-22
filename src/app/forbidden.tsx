export default function Forbidden() {
  return (
    <main className="shell">
      <section className="workspace" aria-labelledby="access-denied-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">Accès refusé</p>
            <h1 id="access-denied-title">Cette session ne peut pas ouvrir le cockpit</h1>
          </div>
        </header>
        <section className="panel">
          <p>Déconnectez-vous puis contactez un propriétaire ICOS si cet accès est attendu.</p>
        </section>
      </section>
    </main>
  );
}
