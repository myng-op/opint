// Single-surface app: the interviewee voice chat at `/`.
// Router is kept around a trivial single route so we can add public-facing pages
// (e.g. "thanks, the interview is complete") without another refactor.

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Interview from './routes/Interview.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Interview />} />
      </Routes>
    </BrowserRouter>
  );
}
