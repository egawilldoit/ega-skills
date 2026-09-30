import { OAuthConsent } from "./OAuthConsent";
import { Login } from "./Login";
import { Home } from "./Home";

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/oauth/consent") return <OAuthConsent />;
  if (path === "/login") return <Login />;
  return <Home />;
}
