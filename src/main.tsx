import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, defaultTheme } from '@adobe/react-spectrum';
import App from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider theme={defaultTheme} locale="ja-JP" minHeight="100dvh">
      <App />
    </Provider>
  </StrictMode>,
);
