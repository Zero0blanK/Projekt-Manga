import { AlertTriangle } from 'lucide-react';

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';

export function Toaster() {
  const { toasts } = useToast();
  const hasOpenToasts = toasts.some((toast) => toast.open);

  return (
    // Reset Radix's paused timer state when the last open toast closes.
    <ToastProvider key={hasOpenToasts ? 'active' : 'idle'} duration={5000}>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        return (
          <Toast key={id} variant={variant} {...props}>
            <div className="flex min-w-0 items-start gap-2.5">
              {variant === 'destructive' && (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive-foreground" />
              )}
              <div className="grid min-w-0 gap-0.5">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && <ToastDescription>{description}</ToastDescription>}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
