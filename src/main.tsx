import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, defaultTheme } from '@adobe/react-spectrum';
import App from './App';
import './app.css';

// claude.ai で開いたときは、ビューアーのテーマ指定（data-theme）に合わせる
function useScheme(): 'light' | 'dark' | undefined {
  const read = (): 'light' | 'dark' | undefined => {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : undefined;
  };
  const [scheme, setScheme] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setScheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return scheme;
}

function Root() {
  const scheme = useScheme();
  return (
    <Provider theme={defaultTheme} colorScheme={scheme} locale="ja-JP" minHeight="100%">
      <App />
    </Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
