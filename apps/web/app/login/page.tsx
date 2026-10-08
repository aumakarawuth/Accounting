import { LoginForm } from '@/components/LoginForm';
import { LoginShell } from '@/components/LoginShell';

export default function StudentLogin() {
  return <LoginShell><LoginForm kind="student" /></LoginShell>;
}
