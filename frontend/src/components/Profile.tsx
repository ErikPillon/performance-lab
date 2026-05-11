import { useState } from 'react';

interface ProfileProps {
  user: {
    name?: string;
    email?: string;
    picture?: string;
  };
  onLogout: () => void;
}

const Profile = ({ user, onLogout }: ProfileProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button onClick={() => setIsOpen(!isOpen)} className="w-8 h-8 rounded-full overflow-hidden">
        <img src={user.picture} alt="user" className="w-full h-full object-cover" />
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-surface-container-lowest border border-surface-variant rounded-md shadow-lg py-1">
          <div className="px-4 py-2 text-sm text-on-surface-variant">
            <p className="font-semibold">{user.name}</p>
            <p className="truncate">{user.email}</p>
          </div>
          <div className="border-t border-surface-variant my-1"></div>
          <a
            href="http://localhost:8000/api/strava/authorize"
            className="block px-4 py-2 text-sm text-on-surface hover:bg-surface-container-low"
          >
            Connect to Strava
          </a>
          <button
            onClick={async () => {
              try {
                const response = await fetch('http://localhost:8000/api/garmin/fetch');
                if (response.ok) {
                  alert('Garmin activities fetched and saved.');
                } else {
                  alert('Failed to fetch Garmin activities.');
                }
              } catch (error) {
                console.error('Error fetching Garmin activities:', error);
                alert('An error occurred while fetching Garmin activities.');
              }
            }}
            className="block w-full text-left px-4 py-2 text-sm text-on-surface hover:bg-surface-container-low"
          >
            Connect to Garmin
          </button>
          <div className="border-t border-surface-variant my-1"></div>
          <button
            onClick={onLogout}
            className="block w-full text-left px-4 py-2 text-sm text-on-surface hover:bg-surface-container-low"
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
};

export default Profile;
