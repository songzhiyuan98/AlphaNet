import Link from "next/link";

export default function AgentNotFound() {
  return (
    <main className="publicAgentPage ownerCentered">
      <section className="serviceUnavailable">
        <span className="serviceUnavailableMark" aria-hidden="true">
          404
        </span>
        <h1>找不到这个 Agent</h1>
        <p>它可能尚未启用、已归档，或 Handle 不存在。</p>
        <Link className="secondaryButton buttonLink" href="/">
          返回 AlphaNet
        </Link>
      </section>
    </main>
  );
}
