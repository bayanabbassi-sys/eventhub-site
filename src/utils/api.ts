import { projectId, publicAnonKey } from './supabase/info';

const API_URL = `https://${projectId}.supabase.co/functions/v1/make-server-08658f87`;

interface ApiResponse<T = any> {
  success?: boolean;
  error?: string;
  [key: string]: any;
}

class ApiClient {
  private accessToken: string | null = null;

  setAccessToken(token: string | null) {
    this.accessToken = token;
    if (token) {
      localStorage.setItem('staff_mgmt_access_token', token);
    } else {
      localStorage.removeItem('staff_mgmt_access_token');
    }
  }

  getAccessToken(): string | null {
    if (!this.accessToken) {
      this.accessToken = localStorage.getItem('staff_mgmt_access_token');
    }
    return this.accessToken;
  }

  private async request<T = any>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getAccessToken();
    const isUsingToken = token && token !== publicAnonKey;
    
    if (isUsingToken) {
      console.log(`API Request to ${endpoint} with auth token (${token?.substring(0, 20)}...)`);
    } else {
      console.log(`API Request to ${endpoint} with public key`);
    }
    
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token || publicAnonKey}`,
      ...options.headers,
    };

    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        console.error(`API Error for ${endpoint}:`, response.status, error.error);
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      console.log(`API Success for ${endpoint}`);
      return response.json();
    } catch (error) {
      // Re-throw with more context for network errors
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error('Network error: Unable to connect to server');
      }
      throw error;
    }
  }

  // Auth
  async login(email: string, password: string) {
    const result = await this.request<{
      success: boolean;
      accessToken: string;
      user: any;
    }>('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    
    if (result.accessToken) {
      this.setAccessToken(result.accessToken);
    }
    
    return result;
  }

  async signup(email: string, password: string, name: string, role = 'staff') {
    return this.request('/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, role }),
    });
  }

  async setupPassword(email: string, tempPassword: string, newPassword: string) {
    const result = await this.request<{
      success: boolean;
      accessToken: string;
      user: any;
      message: string;
    }>('/staff/setup-password', {
      method: 'POST',
      body: JSON.stringify({ email, tempPassword, newPassword }),
    });
    
    if (result.accessToken) {
      this.setAccessToken(result.accessToken);
    }
    
    return result;
  }

  logout() {
    this.setAccessToken(null);
  }

  // Events
  async getEvents() {
    return this.request<{ events: any[] }>('/events');
  }

  async createEvent(eventData: any) {
    return this.request<{ success: boolean; event: any }>('/events', {
      method: 'POST',
      body: JSON.stringify(eventData),
    });
  }

  async updateEvent(eventId: string, eventData: any) {
    return this.request<{ success: boolean; event: any }>(`/events/${eventId}`, {
      method: 'PUT',
      body: JSON.stringify(eventData),
    });
  }

  async cancelEvent(eventId: string) {
    return this.request<{ success: boolean; event: any }>(`/events/${eventId}/cancel`, {
      method: 'POST',
    });
  }

  async reinstateEvent(eventId: string) {
    return this.request<{ success: boolean; event: any }>(`/events/${eventId}/reinstate`, {
      method: 'POST',
    });
  }

  async deleteEvent(eventId: string) {
    return this.request<{ success: boolean }>(`/events/${eventId}`, {
      method: 'DELETE',
    });
  }

  async closeEvent(eventId: string, approvedStaffIds: string[]) {
    return this.request<{ success: boolean; event: any }>(`/events/close`, {
      method: 'POST',
      body: JSON.stringify({ eventId, approvedStaffIds }),
    });
  }

  // Staff
  async getStaff() {
    return this.request<{ staff: any[] }>('/staff');
  }

  async inviteStaff(email: string, name: string, phone: string) {
    // Get the app URL from the current location
    const appUrl = window.location.origin;
    
    return this.request<{ 
      success: boolean; 
      staff: any; 
      tempPassword: string; 
      emailSent: boolean;
      isTestingMode?: boolean;
      invitationLink?: string;
    }>(
      '/staff/invite',
      {
        method: 'POST',
        body: JSON.stringify({ email, name, phone, appUrl }),
      }
    );
  }

  async updateStaff(staffId: string, name: string, email: string, phone: string, level: string, telegramUsername: string) {
    return this.request<{ success: boolean; staff: any }>(
      `/staff/${staffId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ name, email, phone, level, telegramUsername }),
      }
    );
  }

  async sendPasswordReset(staffId: string) {
    return this.request<{ 
      success: boolean; 
      message: string; 
      emailSent: boolean;
      isTestingMode?: boolean;
      tempPassword?: string;
    }>(
      '/staff/password-reset',
      {
        method: 'POST',
        body: JSON.stringify({ staffId }),
      }
    );
  }

  async sendTelegramTest(staffId: string) {
    return this.request<{ 
      success: boolean; 
      message: string;
    }>(
      '/telegram/test',
      {
        method: 'POST',
        body: JSON.stringify({ staffId }),
      }
    );
  }

  async deleteStaff(staffId: string) {
    return this.request<{ success: boolean; message: string }>(
      `/staff/${staffId}`,
      {
        method: 'DELETE',
      }
    );
  }

  // Points
  async adjustPoints(staffId: string, points: number, reason: string) {
    return this.request<{
      success: boolean;
      staff: any;
      adjustment: any;
      leveledUp: boolean;
    }>('/points/adjust', {
      method: 'POST',
      body: JSON.stringify({ staffId, points, reason }),
    });
  }

  async getAdjustments() {
    return this.request<{ adjustments: any[]; transactions: any[] }>('/adjustments');
  }

  // Signups
  async signUpForEvent(eventId: string) {
    return this.request<{ success: boolean; event: any }>('/signups', {
      method: 'POST',
      body: JSON.stringify({ eventId }),
    });
  }

  async cancelSignUp(eventId: string) {
    return this.request<{ success: boolean; event: any }>(`/signups/${eventId}`, {
      method: 'DELETE',
    });
  }

  async adminSignUpStaff(eventId: string, staffIds: string[]) {
    return this.request<{ success: boolean; event: any; addedCount: number }>('/signups/admin', {
      method: 'POST',
      body: JSON.stringify({ eventId, staffIds }),
    });
  }

  async confirmParticipation(eventId: string, staffId: string) {
    return this.request<{ success: boolean; event: any }>('/participation/confirm', {
      method: 'POST',
      body: JSON.stringify({ eventId, staffId }),
    });
  }

  // Initialization
  async initialize() {
    return this.request<{ success: boolean; message: string; credentials?: any }>(
      '/init',
      {
        method: 'POST',
      }
    );
  }

  async checkStatus() {
    try {
      // Use public anon key for status check
      const response = await fetch(`${API_URL}/status`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
        },
      });
      
      if (!response.ok) {
        console.error('Status check failed with status:', response.status);
        // Return not initialized if status check fails
        return { initialized: false };
      }
      
      return response.json();
    } catch (error) {
      console.error('Status check error:', error);
      // Return not initialized on error to show initialization screen
      return { initialized: false };
    }
  }

  // Admin Settings
  async getAdminSettings() {
    return this.request<{ email: string; phone: string }>('/admin/settings');
  }

  async saveAdminSettings(email: string, phone: string) {
    return this.request<{ success: boolean }>('/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ email, phone }),
    });
  }

  // Levels
  async getLevels() {
    try {
      // Use public anon key for levels - they're needed during login
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${publicAnonKey}`,
      };

      console.log('Fetching levels from:', `${API_URL}/levels`);
      const response = await fetch(`${API_URL}/levels`, {
        headers,
        mode: 'cors',
      });
      
      console.log('Levels response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('Levels fetch failed with status:', response.status, errorText);
        return { levels: [] };
      }
      
      const data = await response.json();
      console.log('Levels fetched successfully:', data?.levels?.length || 0, 'levels');
      return data;
    } catch (error) {
      console.error('Levels fetch error:', error);
      // Log more details about the error
      if (error instanceof TypeError) {
        console.error('This is likely a network or CORS error.');
        console.error('URL being fetched:', `${API_URL}/levels`);
        console.error('Full error:', error.message);
      }
      return { levels: [] };
    }
  }

  async addLevel(name: string, minPoints: number) {
    return this.request<{ success: boolean; level: any }>('/levels', {
      method: 'POST',
      body: JSON.stringify({ name, minPoints }),
    });
  }

  async updateLevel(levelId: string, name: string, minPoints: number) {
    return this.request<{ success: boolean; level: any }>(`/levels/${levelId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, minPoints }),
    });
  }

  async deleteLevel(levelId: string) {
    return this.request<{ success: boolean }>(`/levels/${levelId}`, {
      method: 'DELETE',
    });
  }

  async reorderLevel(levelId: string, direction: 'up' | 'down') {
    return this.request<{ success: boolean; levels: any[] }>('/levels/reorder', {
      method: 'POST',
      body: JSON.stringify({ levelId, direction }),
    });
  }

  // WhatsApp Integration
  async connectWhatsApp(phoneNumberId: string, accessToken: string) {
    return this.request<{ success: boolean; phoneNumber?: string }>('/whatsapp/connect', {
      method: 'POST',
      body: JSON.stringify({ phoneNumberId, accessToken }),
    });
  }

  async getWhatsAppStatus() {
    return this.request<{ connected: boolean; phoneNumber?: string }>('/whatsapp/status');
  }

  // Telegram Integration
  async connectTelegram(botToken: string) {
    return this.request<{ success: boolean; botName?: string }>('/telegram/connect', {
      method: 'POST',
      body: JSON.stringify({ botToken }),
    });
  }

  async getTelegramStatus() {
    return this.request<{ connected: boolean; botName?: string }>('/telegram/status');
  }

  async getTelegramRecentChats() {
    return this.request<{ 
      success: boolean; 
      chats: Array<{
        chatId: string;
        firstName: string;
        lastName: string;
        username: string;
        lastMessage: string;
        timestamp: number;
      }>;
      count: number;
    }>('/telegram/get-recent-chats', {
      method: 'POST',
    });
  }

  async clearTelegramUpdates() {
    return this.request<{ success: boolean; message: string }>('/telegram/clear-updates', {
      method: 'POST',
    });
  }

  async getNotificationDebug() {
    return this.request<any>('/debug/notifications');
  }

  // Email Configuration
  async getEmailConfig() {
    return this.request<{ fromEmail: string; isTestMode: boolean }>('/email-config');
  }
}

export const api = new ApiClient();