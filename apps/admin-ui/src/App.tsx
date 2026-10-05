import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Shell } from './components/Shell';
import { useT } from './i18n';

// Pages with editors (CodeMirror) are loaded on demand.
const ToolsPage = lazy(() => import('./pages/Tools').then((m) => ({ default: m.ToolsPage })));
const SourcesPage = lazy(() => import('./pages/Sources').then((m) => ({ default: m.SourcesPage })));
const ServersPage = lazy(() => import('./pages/Servers').then((m) => ({ default: m.ServersPage })));
const PlaygroundPage = lazy(() => import('./pages/Playground').then((m) => ({ default: m.PlaygroundPage })));
const ComposerPage = lazy(() => import('./pages/Composer').then((m) => ({ default: m.ComposerPage })));
const PoliciesPage = lazy(() => import('./pages/Policies').then((m) => ({ default: m.PoliciesPage })));
const PiiPage = lazy(() => import('./pages/Pii').then((m) => ({ default: m.PiiPage })));
const ProjectionsPage = lazy(() => import('./pages/Projections').then((m) => ({ default: m.ProjectionsPage })));
const DriftPage = lazy(() => import('./pages/Drift').then((m) => ({ default: m.DriftPage })));
const ObservabilityPage = lazy(() => import('./pages/Observability').then((m) => ({ default: m.ObservabilityPage })));
const CallsPage = lazy(() => import('./pages/Calls').then((m) => ({ default: m.CallsPage })));
const SessionsPage = lazy(() => import('./pages/Sessions').then((m) => ({ default: m.SessionsPage })));
const AgentsPage = lazy(() => import('./pages/Agents').then((m) => ({ default: m.AgentsPage })));
const AuditPage = lazy(() => import('./pages/Audit').then((m) => ({ default: m.AuditPage })));
const UsersPage = lazy(() => import('./pages/Users').then((m) => ({ default: m.UsersPage })));
const TokensPage = lazy(() => import('./pages/Tokens').then((m) => ({ default: m.TokensPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));

export function App() {
  const t = useT();
  return (
    <Shell>
      <Suspense fallback={<div className="loading content">{t('common.loading')}</div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/tools" replace />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/servers" element={<ServersPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/composer" element={<ComposerPage />} />
          <Route path="/policies" element={<PoliciesPage />} />
          <Route path="/pii" element={<PiiPage />} />
          <Route path="/projections" element={<ProjectionsPage />} />
          <Route path="/drift" element={<DriftPage />} />
          <Route path="/observability" element={<ObservabilityPage />} />
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/tools" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
