// App shell. Two surfaces:
//   /          — interviewee voice chat (linked, public-facing)
//   /review    — operator list of past interviews (UNLINKED; typed URL only)
//   /review/:id — single transcript detail
//
// The review routes are deliberately not linked from `/` so the participant
// surface stays focused. No auth — demo only.

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Interview from './routes/Interview.jsx';
import Review from './routes/Review.jsx';
import ReviewDetail from './routes/ReviewDetail.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Interview />} />
        <Route path="/review" element={<Review />} />
        <Route path="/review/:id" element={<ReviewDetail />} />
      </Routes>
    </BrowserRouter>
  );
}
