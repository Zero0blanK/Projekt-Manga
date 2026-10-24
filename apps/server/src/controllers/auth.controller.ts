import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import authService, { SESSION_COOKIE_NAME } from '../services/auth.service.js';
import { writeSessionCookie } from '../utils/sessionCookie.js';
import type {
  RegisterBody,
  LoginBody,
  RegisterDeviceBody,
  DeleteAccountBody,
} from '@projekt-manga/schemas';

/** sameSite: "lax" requires the web app and this API to share a registrable domain (see
 * .env.example's note on CLIENT_URL) — a cross-site deployment (frontend and API on
 * different domains) would have the browser silently drop this cookie. That would need
 * "none" plus a real HTTPS origin.
 *
 * secure: the desktop installer runs with NODE_ENV=production but serves the app over plain
 * HTTP on `http://projektmanga.localhost:<port>`. `Secure` still works there because the
 * secure-contexts spec treats `localhost` *and its subdomains* as potentially trustworthy
 * (apps/web/src/proxy.ts forwards the cookie unchanged). Keep the gate on NODE_ENV;
 * switching to the request scheme would weaken hosted deployments. */
function setSessionCookie(res: Response, sessionToken: string) {
  writeSessionCookie(res, sessionToken);
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated as RegisterBody;
    const { user, token } = await authService.register(body, req.headers['user-agent']);
    setSessionCookie(res, token);
    return HTTPSuccessResponse(res, 201, 'Account created', { user });
  } catch (error) {
    return next(error);
  }
};

const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated as LoginBody;
    const { user, token } = await authService.login(body, req.headers['user-agent']);
    setSessionCookie(res, token);
    return HTTPSuccessResponse(res, 200, 'Logged in', { user });
  } catch (error) {
    return next(error);
  }
};

const logout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The raw cookie, not req.sessionId — see authService.logout on why.
    await authService.logout(req.cookies?.[SESSION_COOKIE_NAME] as string | undefined);
    clearSessionCookie(res);
    return HTTPSuccessResponse(res, 200, 'Logged out', null);
  } catch (error) {
    return next(error);
  }
};

/** Always 200, even when unauthenticated — an account is optional, so "no one's logged
 * in" is a normal response, not an error the frontend needs to handle specially. */
const me = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user ? authService.toPublicUser(req.user) : null;
    return HTTPSuccessResponse(res, 200, 'Current session', { user });
  } catch (error) {
    return next(error);
  }
};

const deleteAccount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // requireAuth guarantees req.user is set on this route.
    const { password } = req.validated as DeleteAccountBody;
    await authService.deleteAccount(req.user!.id, password);
    clearSessionCookie(res);
    return HTTPSuccessResponse(res, 200, 'Account deleted', null);
  } catch (error) {
    return next(error);
  }
};

const registerDevice = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated as RegisterDeviceBody;
    const device = await authService.registerDevice(req.user!.id, body.label, body.platform);
    return HTTPSuccessResponse(res, 201, 'Device registered', device);
  } catch (error) {
    return next(error);
  }
};

const signOutOtherDevices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // requireAuth guarantees req.user/req.sessionId are set on this route.
    const revoked = await authService.signOutOtherDevices(req.user!.id, req.sessionId!);
    return HTTPSuccessResponse(res, 200, 'Signed out of other devices', { revoked });
  } catch (error) {
    return next(error);
  }
};

const authController = {
  register,
  login,
  logout,
  me,
  deleteAccount,
  registerDevice,
  signOutOtherDevices,
};

export default authController;
