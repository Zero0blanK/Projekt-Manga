'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { answerModelPrompt, useModelPrompt } from '@/lib/page-translation';

/**
 * The question asked the first time a page is translated before the translation models
 * are downloaded: download them now, or keep reading the text on this device. Either way
 * the page is translated; the models only make it better once they are in.
 */
export function TranslationModelPrompt() {
  const prompt = useModelPrompt();
  return (
    <AlertDialog open={prompt !== null} onOpenChange={(open) => !open && answerModelPrompt(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Download the translation models?</AlertDialogTitle>
          <AlertDialogDescription>
            Page translation reads Japanese best with its own models, which download once
            {prompt ? ` (about ${Math.round(prompt.size / 1_000_000)} MB)` : ''} and then run on
            this computer. Until they are in, pages are read on this device instead. You can also
            download or remove them in Settings › Reader › Page translation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answerModelPrompt(false)}>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={() => answerModelPrompt(true)}>Download</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
