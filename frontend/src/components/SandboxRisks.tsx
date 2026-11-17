// The risk text shown wherever a human is asked to allow running without Chromium's sandbox.
export function SandboxRisks() {
  return (
    <>
      <p>Without the sandbox, a malicious page could take over the browser&apos;s renderer, and the browser would run it as the host user:</p>
      <ul>
        <li>the profile keeps logins and cookies;</li>
        <li>pages can reach loopback and LAN services;</li>
        <li>a compromised page runs code as the host user, with access to their files and projects.</li>
      </ul>
    </>
  );
}
