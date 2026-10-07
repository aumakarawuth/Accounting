import { LoginForm } from '@/components/LoginForm';
import { LoginShell } from '@/components/LoginShell';

export default function StaffLogin() {
  return <LoginShell><LoginForm kind="staff" /></LoginShell>;
}
