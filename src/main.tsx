import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {initMonitoring, reportError} from './monitoring';
import './index.css';

initMonitoring();

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => {
    console.error(error);
    reportError(error, info.componentStack);
  },
  onCaughtError: (error, info) => reportError(error, info.componentStack),
}).render(<App />);
