// Example using Axios
import axios from 'axios';

const apiClient = axios.create({
  // Use environment variables so it works in dev and prod!
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: {
    'Content-Type': 'application/json',
  },
});

export default apiClient;