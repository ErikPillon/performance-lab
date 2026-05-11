import { useGoogleLogin } from '@react-oauth/google';
import { FcGoogle } from 'react-icons/fc';

interface LoginProps {
  onSuccess: (credentialResponse: any) => void;
  onError: () => void;
}

const Login = ({ onSuccess, onError }: LoginProps) => {
  const login = useGoogleLogin({
    onSuccess: codeResponse => onSuccess(codeResponse),
    onError: () => onError(),
  });

  return (
    <div className="flex justify-center items-center">
      <button
        onClick={() => login()}
        className="flex items-center justify-center px-4 py-2 border border-surface-variant rounded-md shadow-sm text-sm font-medium text-on-surface bg-surface hover:bg-surface-container-low focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
      >
        <span className="mr-2 -ml-1 flex items-center justify-center">
          <FcGoogle size={20} />
        </span>
        Sign in with Google
      </button>
    </div>
  );
};

export default Login;
