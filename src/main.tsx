import {createRoot} from 'react-dom/client';
import App from './App';
import {PortalPage} from './features/buyers/PortalPage';
import {initMonitoring, reportError} from './monitoring';
import './index.css';

initMonitoring();

// A buyer opening a private portal link sees only their statement, with no sign-in.
const portalToken = new URLSearchParams(window.location.search).get('portal');

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => {
    console.error(error);
    reportError(error, info.componentStack);
  },
  onCaughtError: (error, info) => reportError(error, info.componentStack),
}).render(portalToken ? <PortalPage token={portalToken} /> : <App />);
