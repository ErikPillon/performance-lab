import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { FcGoogle } from 'react-icons/fc';

interface LoginProps {
  onSuccess: (credentialResponse: CredentialResponse) => void;
  onError: () => void;
}

const Login = ({ onSuccess, onError }: LoginProps) => {
  return (
    <div className="flex justify-center items-center">
      <GoogleLogin
        onSuccess={onSuccess}
        onError={onError}
        render={({ onClick, disabled }) => (
          <button
            onClick={onClick}
            disabled={disabled}
            className="flex items-center justify-center px-4 py-2 border border-surface-variant rounded-md shadow-sm text-sm font-medium text-on-surface bg-surface hover:bg-surface-container-low focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
          >
            <FcGoogle className="mr-2 -ml-1 w-5 h-5" />
            Sign in with Google
          </button>
        )}
      />
    </div>
  );
};

export default Login;
