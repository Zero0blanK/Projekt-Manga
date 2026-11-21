import { redirect } from 'next/navigation';

// Recents was merged into History: "continue reading" is on the Library and History, and
// newly updated titles are in Notifications and the Library's rail. Old links still land.
export default function RecentsPage() {
  redirect('/history');
}
