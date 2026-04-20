// Top-level router. Two surfaces share one build:
//   `/`      → interviewee voice chat (what the subject sees)
//   `/admin` → operator screen (question sets, past interviews)
// Keeping them in one React app so they can share components + types
// as the project grows. Auth comes in Phase 8.

import { BrowserRouter, Routes, Route, Link, NavLink } from 'react-router-dom';
import Interview from './routes/Interview.jsx';
import Admin from './routes/Admin.jsx';

const navStyle = { padding: '12px 20px', borderBottom: '1px solid #eee', display: 'flex', gap: 16 };
const linkStyle = ({ isActive }) => ({
  textDecoration: 'none',
  color: isActive ? '#111' : '#666',
  fontWeight: isActive ? 600 : 400,
});

export default function App() {
  return (
    <BrowserRouter>
      <nav style={navStyle}>
        <NavLink to="/" end style={linkStyle}>Interview</NavLink>
        <NavLink to="/admin" style={linkStyle}>Admin</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Interview />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </BrowserRouter>
  );
}
