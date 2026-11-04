import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';

/** A confirmation with a short way back, for an action the reader may regret. */
export function toastWithUndo(description: string, undo: () => Promise<unknown>) {
  toast({
    description,
    action: (
      <ToastAction
        altText="Undo"
        onClick={() =>
          void undo().catch(() => toast({ description: "Couldn't undo that. Try again." }))
        }
      >
        Undo
      </ToastAction>
    ),
  });
}
