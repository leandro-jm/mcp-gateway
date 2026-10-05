import { defineMessages } from '@mcp-gateway/i18n';

/** Login screen and session bootstrap. */
export const auth = defineMessages('auth', {
  en: {
    'auth.signIn': 'Sign in',
    'auth.signingIn': 'Signing in…',
    'auth.username': 'Username',
    'auth.password': 'Password',
    'auth.loginFailed': 'Sign-in failed (HTTP {status})',
    'auth.sessionExpired': 'Session expired',
    'auth.noAdminAccess': 'No access to the Admin API: {error}',
    'auth.noTenants': 'No tenant registered. Create the first one with {endpoint}.',
    'auth.loadingSession': 'Loading session…',
  },
  'pt-BR': {
    'auth.signIn': 'Entrar',
    'auth.signingIn': 'Entrando…',
    'auth.username': 'Usuário',
    'auth.password': 'Senha',
    'auth.loginFailed': 'Falha no login (HTTP {status})',
    'auth.sessionExpired': 'Sessão expirada',
    'auth.noAdminAccess': 'Sem acesso à Admin API: {error}',
    'auth.noTenants': 'Nenhum tenant cadastrado. Crie o primeiro com {endpoint}.',
    'auth.loadingSession': 'Carregando sessão…',
  },
  es: {
    'auth.signIn': 'Iniciar sesión',
    'auth.signingIn': 'Iniciando sesión…',
    'auth.username': 'Usuario',
    'auth.password': 'Contraseña',
    'auth.loginFailed': 'Error al iniciar sesión (HTTP {status})',
    'auth.sessionExpired': 'Sesión expirada',
    'auth.noAdminAccess': 'Sin acceso a la Admin API: {error}',
    'auth.noTenants': 'No hay ningún tenant registrado. Cree el primero con {endpoint}.',
    'auth.loadingSession': 'Cargando sesión…',
  },
});
