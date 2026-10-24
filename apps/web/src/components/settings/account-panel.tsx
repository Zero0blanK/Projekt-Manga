'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  registerBodySchema,
  loginBodySchema,
  type RegisterBody,
  type LoginBody,
} from '@projekt-manga/schemas';
import { ApiError } from '@projekt-manga/api-client';
import { SHELF_OPTIONS, useSetting } from '@/lib/app-store';
import { useMangaLibrary } from '@/lib/library-store';
import { useCurrentUser, sessionActions } from '@/lib/session-resource';
import { TrackersPanel } from '@/components/settings/trackers-panel';
import {
  Panel,
  Field,
  Group,
  OptionSelect,
  Toggle,
  TextInput,
  ActionButton,
} from '@/components/settings/field-controls';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';

const SHELF_CHOICES = [{ value: 'none', label: 'None' }, ...SHELF_OPTIONS];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const form = useForm<RegisterBody>({
    resolver: zodResolver(registerBodySchema),
    defaultValues: { email: '', password: '', display_name: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await sessionActions.register({
        email: values.email,
        password: values.password,
        display_name: values.display_name || undefined,
      });
      toast({ description: "Account created — you're signed in." });
      onSuccess();
    } catch (error) {
      form.setError('root', { message: errorMessage(error, "Couldn't create the account.") });
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-3">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" className="h-8 text-xs" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  className="h-8 text-xs"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="display_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Display name (optional)</FormLabel>
              <FormControl>
                <Input className="h-8 text-xs" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {form.formState.errors.root && (
          <p className="text-[0.8rem] font-medium text-destructive">
            {form.formState.errors.root.message}
          </p>
        )}
        <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </Form>
  );
}

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const form = useForm<LoginBody>({
    resolver: zodResolver(loginBodySchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await sessionActions.login(values);
      toast({ description: 'Signed in.' });
      onSuccess();
    } catch (error) {
      form.setError('root', { message: errorMessage(error, "Couldn't sign in.") });
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-3">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" className="h-8 text-xs" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  className="h-8 text-xs"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {form.formState.errors.root && (
          <p className="text-[0.8rem] font-medium text-destructive">
            {form.formState.errors.root.message}
          </p>
        )}
        <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Form>
  );
}

/** Signed-out state. The first account on a server claims the existing anonymous
 * library/history (apps/server's auth.service.ts), so the copy below says so. */
function SignedOutAccount() {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const refresh = () => window.location.reload();

  return (
    <>
      <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-xs text-muted-foreground">
        Creating an account unlocks cross-device sync — your desktop app keeps working fully offline
        against its own local library either way. If this is the first account on this server, it
        takes over your existing library and history.
      </div>
      <div role="tablist" aria-label="Create account or sign in" className="flex gap-2 pb-1">
        <button
          role="tab"
          aria-selected={mode === 'register'}
          aria-controls="account-auth-panel"
          onClick={() => setMode('register')}
          className={`rounded-lg px-3 py-1 text-xs font-medium transition pointer-coarse:min-h-9 ${
            mode === 'register'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          Create account
        </button>
        <button
          role="tab"
          aria-selected={mode === 'login'}
          aria-controls="account-auth-panel"
          onClick={() => setMode('login')}
          className={`rounded-lg px-3 py-1 text-xs font-medium transition pointer-coarse:min-h-9 ${
            mode === 'login'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          Sign in
        </button>
      </div>
      <div id="account-auth-panel" role="tabpanel">
        {mode === 'register' ? (
          <RegisterForm onSuccess={refresh} />
        ) : (
          <LoginForm onSuccess={refresh} />
        )}
      </div>
    </>
  );
}

/** Account switch controls used by the restore blocker when the session owner changes. */
export function RestoreAccountRecovery() {
  const { user, loading } = useCurrentUser();
  const [signingOut, setSigningOut] = useState(false);

  if (loading) {
    return <p className="mt-4 text-sm text-muted-foreground">Checking the current account…</p>;
  }

  if (!user) {
    return (
      <div className="mt-5 border-t border-border pt-4">
        <p className="mb-3 text-sm font-medium">
          Sign in as the account that started this restore.
        </p>
        <LoginForm onSuccess={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="text-sm">Current account: {user.email}</p>
      <Button
        type="button"
        className="mt-3"
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          void sessionActions
            .logout()
            .then(() => window.location.reload())
            .catch(() => {
              toast({ description: "Couldn't sign out — try again." });
              setSigningOut(false);
            });
        }}
      >
        {signingOut ? 'Signing out…' : 'Sign out to switch accounts'}
      </Button>
    </div>
  );
}

function SignedInAccount({ email, displayName }: { email: string; displayName: string | null }) {
  const [signingOut, setSigningOut] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const handleLogout = () => {
    setSigningOut(true);
    sessionActions
      .logout()
      .then(() => {
        toast({ description: 'Signed out.' });
        window.location.reload();
      })
      .catch(() => {
        toast({ description: "Couldn't sign out — try again." });
        setSigningOut(false);
      });
  };

  const handleSignOutOtherDevices = () => {
    setRevoking(true);
    sessionActions
      .signOutOtherDevices()
      .then((revoked) => {
        toast({
          description:
            revoked > 0
              ? `Signed out of ${revoked} other device${revoked === 1 ? '' : 's'}.`
              : 'No other devices were signed in.',
        });
      })
      .catch(() => toast({ description: "Couldn't sign out other devices — try again." }))
      .finally(() => setRevoking(false));
  };

  return (
    <>
      <Field label="Email" hint="Used to sign in on other devices">
        <span className="text-xs text-muted-foreground">{email}</span>
      </Field>
      {/* Local-only: there is no PATCH /api/auth/me to update the account's display_name. */}
      <Field label="Display name" hint="Stored on this device only, same as before signing in">
        <TextInput settingKey="displayName" placeholder={displayName || 'Reader'} />
      </Field>
      <Field
        label="Other devices"
        hint="Signs out every other browser or desktop app signed into this account"
      >
        <ActionButton onClick={handleSignOutOtherDevices} disabled={revoking}>
          {revoking ? 'Signing out…' : 'Sign out other devices'}
        </ActionButton>
      </Field>
      <Field label="Session" hint="Signs this device out">
        <ActionButton onClick={handleLogout} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </ActionButton>
      </Field>
    </>
  );
}

export function AccountPanel() {
  const displayName = useSetting('displayName', '') as string;
  const { manga } = useMangaLibrary();
  const { user, loading: userLoading } = useCurrentUser();

  return (
    <div className="space-y-6">
      <Panel title="Profile" subtitle="Who's reading">
        <div className="flex items-center gap-4 pb-1">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-gradient-primary text-2xl font-bold text-primary-foreground">
            {(user?.display_name || displayName).trim().charAt(0).toUpperCase() || 'M'}
          </div>
          <div>
            <div className="text-lg font-semibold text-foreground">
              {user?.display_name || displayName.trim() || 'Reader'}
            </div>
            <div className="text-xs text-muted-foreground">
              {manga.length} title{manga.length === 1 ? '' : 's'} in your library
            </div>
          </div>
        </div>

        {userLoading ? (
          <div className="space-y-2 py-1">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-8 w-2/3 rounded-lg" />
          </div>
        ) : user ? (
          <SignedInAccount email={user.email} displayName={user.display_name} />
        ) : (
          <SignedOutAccount />
        )}

        {/* TODO: wire up once translated strings exist; there is nothing to switch to. */}
        <Field label="Interface language" hint="Only English strings ship today" disabled>
          <span className="text-xs text-muted-foreground">English</span>
        </Field>
      </Panel>

      {user && (
        <Panel title="Trackers" subtitle="Sync reading progress with third-party services">
          <TrackersPanel />
        </Panel>
      )}

      <Panel title="Library" subtitle="Defaults for titles you add">
        <Field label="Default shelf" hint="Where a title is filed when you add it from Discover">
          <OptionSelect settingKey="defaultShelf" options={SHELF_CHOICES} defaultValue="none" />
        </Field>

        <Group label="Covers" />
        <Field
          label="Show unread count"
          hint="A badge with the number of chapters you haven't read yet"
        >
          <Toggle settingKey="showUnreadBadge" defaultOn />
        </Field>
      </Panel>
    </div>
  );
}
