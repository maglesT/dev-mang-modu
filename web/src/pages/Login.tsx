// Sign-on goes through Medhanta core (D-43): the button sends the browser to core's sign-in page.
export function Login() {
  return (
    <main className="page narrow login">
      <h1><img className="login-logo" src="/brand/dive-logo.svg" alt="Medhanta DIVE" /></h1>
      <p className="muted">Report deviations and follow CAPAs. Sign in with your own Medhanta login.</p>
      <div className="card">
        <a className="button primary" href="/login">Sign in</a>
      </div>
    </main>
  );
}
