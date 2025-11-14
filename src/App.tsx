import { useState, useEffect } from 'react';
import { AdminDashboard } from './components/AdminDashboard';
import { StaffDashboard } from './components/StaffDashboard';
import { LoginScreen } from './components/LoginScreen';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner@2.0.3';
import { api } from './utils/api';
import { formatDate } from './utils/dateUtils';

export type UserRole = 'admin' | 'staff';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  points?: number;
  level?: string;
}

export interface Event {
  id: string;
  name: string;
  date: string;
  endDate?: string; // Optional end date, defaults to same as date
  time: string;
  duration: string;
  location: string;
  description?: string;
  notes?: string;
  points: number;
  requiredLevel: string;
  signedUpStaff: string[];
  signUpTimestamps?: { [staffId: string]: string }; // Track when each staff member signed up
  confirmedStaff?: string[]; // Staff selected to participate (approved)
  pointsAwarded?: string[]; // Staff who have actually received points
  createdAt: string;
  status?: 'draft' | 'open' | 'closed' | 'cancelled';
}

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  phone?: string;
  telegramUsername?: string;
  points: number;
  level: string;
  status: 'active' | 'pending';
  createdAt: string;
}

export interface Level {
  id: string;
  name: string;
  minPoints: number;
  order: number;
}

export interface PointAdjustment {
  id: string;
  staffId: string;
  points: number;
  reason: string;
  timestamp: string;
  adminId: string;
}

export interface PointTransaction {
  id: string;
  staffId: string;
  staffName: string;
  points: number;
  reason: string;
  timestamp: string;
  adminId: string;
  eventId?: string;
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [pointAdjustments, setPointAdjustments] = useState<PointAdjustment[]>([]);
  const [pointTransactions, setPointTransactions] = useState<PointTransaction[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPhone, setAdminPhone] = useState('');
  const [whatsAppConnected, setWhatsAppConnected] = useState(false);
  const [whatsAppPhoneNumber, setWhatsAppPhoneNumber] = useState('');
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [telegramBotName, setTelegramBotName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);

  // Check if user is already logged in and load data
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // First check if database is initialized
        const status = await api.checkStatus();
        console.log('Database status:', status);
        
        setIsInitialized(status.initialized);
        
        if (!status.initialized) {
          console.log('Database not initialized, clearing any stale session and showing initialization screen');
          // Clear any stale session data
          api.logout();
          localStorage.removeItem('staff_mgmt_current_user');
          setIsLoading(false);
          return;
        }
        
        const token = api.getAccessToken();
        console.log('Token found in storage:', token ? 'YES' : 'NO');
        
        if (token) {
          // Load user from localStorage first
          const storedUser = localStorage.getItem('staff_mgmt_current_user');
          if (storedUser) {
            try {
              const user = JSON.parse(storedUser);
              console.log('Restoring session for user:', user.email, 'role:', user.role);
              setCurrentUser(user);
              
              // Load data with user info - pass the user so we know role
              await loadData(user);
              
              // If loadData cleared the user (due to 401), don't continue
              if (!api.getAccessToken()) {
                console.log('Session was invalidated during data load');
                return;
              }
              
              // Refresh user data from staff members if they're staff
              if (user.role === 'staff') {
                const staffRes = await api.getStaff().catch((err) => {
                  console.error('Staff fetch failed during init:', err);
                  return { staff: [] };
                });
                if (staffRes.staff && staffRes.staff.length > 0) {
                  const currentStaff = staffRes.staff.find((s: any) => s.id === user.id);
                  if (currentStaff) {
                    setCurrentUser({
                      ...user,
                      points: currentStaff.points,
                      level: currentStaff.level
                    });
                  }
                }
              }
            } catch (error) {
              console.error('Error loading user data:', error);
              // Clear invalid session
              api.logout();
              localStorage.removeItem('staff_mgmt_current_user');
              setCurrentUser(null);
            }
          } else {
            // Token exists but no stored user - clear token
            console.log('Token exists but no stored user, clearing session');
            api.logout();
          }
        } else {
          console.log('No token found, user needs to log in');
        }
      } catch (error) {
        console.error('Error initializing app:', error);
        // Don't show error toast, just assume not initialized
        setIsInitialized(false);
      } finally {
        setIsLoading(false);
      }
    };

    initializeApp();
  }, []);

  // Load all data from backend
  const loadData = async (user?: User | null) => {
    try {
      // Get token to check if user is logged in
      const token = api.getAccessToken();
      if (!token) {
        console.log('No token available, skipping data load');
        return;
      }

      const userToCheck = user || currentUser;
      
      if (!userToCheck) {
        console.log('No user available, skipping data load');
        return;
      }

      // Track if we get any 401 errors (invalid token)
      let has401Error = false;
      
      const handle401 = (err: any) => {
        const is401 = err.message && err.message.includes('401');
        if (is401) {
          has401Error = true;
          console.error('Authentication error (401) - token may be invalid');
        }
        return err;
      };

      const [eventsRes, staffRes, adjustmentsRes, levelsRes, settingsRes, whatsAppRes, telegramRes] = await Promise.all([
        api.getEvents().catch((err) => { 
          handle401(err);
          console.error('Events fetch failed:', err.message || err); 
          return { events: [] }; 
        }),
        api.getStaff().catch((err) => { 
          handle401(err);
          console.error('Staff fetch failed:', err.message || err); 
          return { staff: [] }; 
        }),
        userToCheck.role === 'admin' 
          ? api.getAdjustments().catch((err) => { 
              handle401(err);
              console.error('Adjustments fetch failed:', err.message || err); 
              return { adjustments: [], transactions: [] }; 
            })
          : Promise.resolve({ adjustments: [], transactions: [] }),
        api.getLevels().catch((err) => { 
          handle401(err);
          console.error('Levels fetch failed in App.tsx:', err.message || err); 
          return { levels: [] }; 
        }),
        userToCheck.role === 'admin'
          ? api.getAdminSettings().catch((err) => { 
              handle401(err);
              console.error('Admin settings fetch failed:', err.message || err); 
              return { email: '', phone: '' }; 
            })
          : Promise.resolve({ email: '', phone: '' }),
        userToCheck.role === 'admin'
          ? api.getWhatsAppStatus().catch((err) => { 
              handle401(err);
              console.error('WhatsApp status fetch failed:', err.message || err); 
              return { connected: false }; 
            })
          : Promise.resolve({ connected: false }),
        userToCheck.role === 'admin'
          ? api.getTelegramStatus().catch((err) => { 
              handle401(err);
              console.error('Telegram status fetch failed:', err.message || err); 
              return { connected: false }; 
            })
          : Promise.resolve({ connected: false })
      ]);
      
      // If we got 401 errors, the token is invalid - log out the user
      if (has401Error) {
        console.log('Invalid authentication token detected, logging out user');
        api.logout();
        localStorage.removeItem('staff_mgmt_current_user');
        setCurrentUser(null);
        toast.error('Your session has expired. Please log in again.');
        return;
      }

      setEvents(eventsRes.events || []);
      setStaffMembers(staffRes.staff || []);
      setPointAdjustments(adjustmentsRes.adjustments || []);
      setPointTransactions(adjustmentsRes.transactions || []);
      setLevels(levelsRes.levels || []);
      if (userToCheck?.role === 'admin') {
        setAdminEmail(settingsRes.email || '');
        setAdminPhone(settingsRes.phone || '');
        setWhatsAppConnected(whatsAppRes.connected || false);
        setWhatsAppPhoneNumber(whatsAppRes.phoneNumber || '');
        setTelegramConnected(telegramRes.connected || false);
        setTelegramBotName(telegramRes.botName || '');
      }
    } catch (error) {
      console.error('Error loading data:', error);
      throw error;
    }
  };

  // Refresh data periodically
  useEffect(() => {
    if (!currentUser) {
      console.log('No user logged in, skipping periodic refresh');
      return;
    }

    const interval = setInterval(async () => {
      try {
        await loadData(currentUser);
      } catch (error) {
        console.error('Error refreshing data:', error);
      }
    }, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [currentUser]);

  const handleLogin = async (email: string, password: string) => {
    try {
      const result = await api.login(email, password);
      
      // Check if user needs to set up password (from server response)
      if (result.success && result.needsPasswordSetup) {
        return { 
          needsPasswordSetup: true, 
          email: result.email || email, 
          tempPassword: result.tempPassword || password 
        };
      }
      
      if (result.success && result.user) {
        // Check if user needs to set up password (status is 'pending')
        if (result.user.status === 'pending') {
          // User needs to change password - return special status
          return { needsPasswordSetup: true, email, tempPassword: password };
        }
        
        const user: User = {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role || 'staff',
          name: result.user.name,
          points: result.user.points,
          level: result.user.level
        };
        
        setCurrentUser(user);
        localStorage.setItem('staff_mgmt_current_user', JSON.stringify(user));
        
        // Load all data
        await loadData(user);
        
        toast.success(`Welcome back, ${user.name}!`);
        return true;
      }
      
      return false;
    } catch (error: any) {
      console.error('Login error:', error);
      
      // Check if it's an invalid credentials error
      if (error.message?.includes('Invalid') || error.message?.includes('credentials')) {
        // Check if database is initialized
        const status = await api.checkStatus().catch(() => ({ initialized: true }));
        if (!status.initialized) {
          toast.error('Database not initialized. Please refresh the page.');
          setIsInitialized(false);
          return false;
        }
        
        // Show helpful message about using demo accounts
        toast.error('❌ Login failed! This email is not registered. Use the demo account buttons to try the app!', {
          duration: 6000,
        });
        return false;
      }
      
      toast.error(error.message || 'Login failed. Please try again.');
      return false;
    }
  };

  const handlePasswordSetup = async (email: string, tempPassword: string, newPassword: string): Promise<boolean> => {
    try {
      const result = await api.setupPassword(email, tempPassword, newPassword);
      
      if (result.success && result.user) {
        const user: User = {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role || 'staff',
          name: result.user.name,
          points: result.user.points,
          level: result.user.level
        };
        
        setCurrentUser(user);
        localStorage.setItem('staff_mgmt_current_user', JSON.stringify(user));
        
        // Load all data
        await loadData(user);
        
        toast.success(`Welcome, ${user.name}!`, {
          description: 'Your password has been set successfully.'
        });
        return true;
      }
      
      return false;
    } catch (error: any) {
      console.error('Password setup error:', error);
      toast.error(error.message || 'Failed to set up password');
      return false;
    }
  };

  const handleLogout = () => {
    api.logout();
    setCurrentUser(null);
    localStorage.removeItem('staff_mgmt_current_user');
    setEvents([]);
    setStaffMembers([]);
    setPointAdjustments([]);
    toast.success('Logged out successfully');
  };

  const addEvent = async (event: Omit<Event, 'id' | 'signedUpStaff' | 'createdAt'>) => {
    try {
      const result = await api.createEvent(event);
      
      if (result.success && result.event) {
        setEvents(prev => [...prev, result.event]);
        
        if (result.event.status === 'open') {
          toast.success(`Event "${event.name}" created and published`, {
            description: 'Email notifications sent to eligible staff members'
          });
        } else if (result.event.status === 'draft') {
          toast.success(`Event "${event.name}" saved as draft`, {
            description: 'Staff cannot see this event yet. Change status to "Open" to publish.'
          });
        } else {
          toast.success(`Event "${event.name}" created successfully`, {
            description: `Status: ${result.event.status}`
          });
        }
      }
    } catch (error: any) {
      console.error('Error adding event:', error);
      toast.error(error.message || 'Failed to create event');
    }
  };

  const updateEvent = async (eventId: string, event: Omit<Event, 'id' | 'signedUpStaff' | 'createdAt'>) => {
    try {
      const result = await api.updateEvent(eventId, event);
      
      if (result.success && result.event) {
        setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        toast.success(`Event "${event.name}" updated successfully`);
      }
    } catch (error: any) {
      console.error('Error updating event:', error);
      toast.error(error.message || 'Failed to update event');
    }
  };

  const cancelEvent = async (eventId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      const result = await api.cancelEvent(eventId);
      
      if (result.success && result.event) {
        setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        toast.success(`Event "${event?.name}" has been cancelled`, {
          description: 'Notifications sent to all participating staff members'
        });
      }
    } catch (error: any) {
      console.error('Error cancelling event:', error);
      toast.error(error.message || 'Failed to cancel event');
    }
  };

  const reinstateEvent = async (eventId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      const result = await api.reinstateEvent(eventId);
      
      if (result.success && result.event) {
        setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        toast.success(`Event "${event?.name}" has been reinstated`, {
          description: 'Event is now active again and visible to staff members'
        });
      }
    } catch (error: any) {
      console.error('Error reinstating event:', error);
      toast.error(error.message || 'Failed to reinstate event');
    }
  };

  const deleteEvent = async (eventId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      await api.deleteEvent(eventId);
      
      setEvents(prev => prev.filter(e => e.id !== eventId));
      toast.success(`Event "${event?.name}" deleted successfully`);
    } catch (error: any) {
      console.error('Error deleting event:', error);
      toast.error(error.message || 'Failed to delete event');
    }
  };

  const addStaffMember = async (email: string, name: string, phone: string) => {
    try {
      const result = await api.inviteStaff(email, name, phone);
      
      if (result.success && result.staff) {
        setStaffMembers(prev => [...prev, result.staff]);
        
        // Store invitation details for display
        if (!result.emailSent && result.tempPassword) {
          // Email didn't send (testing mode), show manual credentials
          const manualInviteData = {
            staff: result.staff,
            tempPassword: result.tempPassword,
            isTestingMode: result.isTestingMode
          };
          // Store in session storage to display in UI
          sessionStorage.setItem('lastFailedInvite', JSON.stringify(manualInviteData));
          console.log('📧 Staff member created successfully. Email in testing mode - manual credentials will be provided.');
        } else {
          // Email sent successfully
          toast.success(`Invitation sent to ${name}`, {
            description: `An invitation email with login credentials has been sent to ${email}`
          });
        }
        
        return result.staff;
      }
      
      return null;
    } catch (error: any) {
      console.error('Error adding staff member:', error);
      toast.error(error.message || 'Failed to add staff member');
      return null;
    }
  };

  const updateStaffMember = async (staffId: string, name: string, email: string, phone: string, level: string, telegramUsername: string) => {
    try {
      const result = await api.updateStaff(staffId, name, email, phone, level, telegramUsername);
      
      if (result.success && result.staff) {
        setStaffMembers(prev => prev.map(s => s.id === staffId ? result.staff : s));
        toast.success(`Updated ${name}'s information`);
      }
    } catch (error: any) {
      console.error('Error updating staff member:', error);
      toast.error(error.message || 'Failed to update staff member');
    }
  };

  const deleteStaffMember = async (staffId: string) => {
    try {
      const staff = staffMembers.find(s => s.id === staffId);
      await api.deleteStaff(staffId);
      
      setStaffMembers(prev => prev.filter(s => s.id !== staffId));
      
      // Also update events to remove this staff member
      setEvents(prev => prev.map(event => ({
        ...event,
        signedUpStaff: event.signedUpStaff.filter(id => id !== staffId)
      })));
      
      toast.success(`${staff?.name} has been removed`);
    } catch (error: any) {
      console.error('Error deleting staff member:', error);
      toast.error(error.message || 'Failed to delete staff member');
    }
  };

  const saveAdminSettings = async (email: string, phone: string) => {
    try {
      await api.saveAdminSettings(email, phone);
      setAdminEmail(email);
      setAdminPhone(phone);
    } catch (error: any) {
      console.error('Error saving admin settings:', error);
      throw error;
    }
  };

  const connectWhatsApp = async (phoneNumberId: string, accessToken: string) => {
    try {
      const result = await api.connectWhatsApp(phoneNumberId, accessToken);
      
      if (result.success) {
        setWhatsAppConnected(true);
        setWhatsAppPhoneNumber(result.phoneNumber || '');
      }
    } catch (error: any) {
      console.error('Error connecting WhatsApp:', error);
      throw error;
    }
  };

  const connectTelegram = async (botToken: string) => {
    try {
      const result = await api.connectTelegram(botToken);
      
      if (result.success) {
        setTelegramConnected(true);
        setTelegramBotName(result.botName || '');
      }
    } catch (error: any) {
      console.error('Error connecting Telegram:', error);
      throw error;
    }
  };

  const addLevel = async (name: string, minPoints: number) => {
    try {
      const result = await api.addLevel(name, minPoints);
      
      if (result.success && result.level) {
        setLevels(prev => [...prev, result.level]);
        toast.success(`Level "${name}" created successfully`);
      }
    } catch (error: any) {
      console.error('Error adding level:', error);
      toast.error(error.message || 'Failed to add level');
    }
  };

  const updateLevel = async (levelId: string, name: string, minPoints: number) => {
    try {
      const result = await api.updateLevel(levelId, name, minPoints);
      
      if (result.success && result.level) {
        setLevels(prev => prev.map(l => l.id === levelId ? result.level : l));
        toast.success(`Level "${name}" updated successfully`);
      }
    } catch (error: any) {
      console.error('Error updating level:', error);
      toast.error(error.message || 'Failed to update level');
    }
  };

  const deleteLevel = async (levelId: string) => {
    try {
      const level = levels.find(l => l.id === levelId);
      await api.deleteLevel(levelId);
      
      setLevels(prev => prev.filter(l => l.id !== levelId));
      toast.success(`Level "${level?.name}" deleted successfully`);
    } catch (error: any) {
      console.error('Error deleting level:', error);
      toast.error(error.message || 'Failed to delete level');
    }
  };

  const reorderLevel = async (levelId: string, direction: 'up' | 'down') => {
    try {
      const result = await api.reorderLevel(levelId, direction);
      
      if (result.success && result.levels) {
        setLevels(result.levels);
      }
    } catch (error: any) {
      console.error('Error reordering level:', error);
      toast.error(error.message || 'Failed to reorder level');
    }
  };

  const sendPasswordReset = async (staffId: string) => {
    try {
      const staff = staffMembers.find(s => s.id === staffId);
      if (!staff) {
        toast.error('Staff member not found');
        return;
      }

      const result = await api.sendPasswordReset(staffId);
      
      if (result.success) {
        if (!result.emailSent && result.tempPassword) {
          // Email didn't send (testing mode), store temp password for manual sharing
          const resetData = {
            staff,
            tempPassword: result.tempPassword,
            isTestingMode: result.isTestingMode
          };
          sessionStorage.setItem('lastFailedReset', JSON.stringify(resetData));
          console.log('🔑 Temporary password generated successfully. Email in testing mode - manual credentials will be provided.');
          
          // Show toast to indicate password was generated
          toast.success(`Password reset generated for ${staff.name}`, {
            description: 'Temporary password is ready to share manually'
          });
        } else {
          // Email sent successfully
          toast.success(`Password reset email sent to ${staff.name}`, {
            description: result.message
          });
        }
      }
    } catch (error: any) {
      console.error('Error sending password reset:', error);
      toast.error(error.message || 'Failed to send password reset email');
    }
  };

  const sendTelegramTest = async (staffId: string) => {
    try {
      const staff = staffMembers.find(s => s.id === staffId);
      if (!staff) {
        toast.error('Staff member not found');
        return;
      }

      if (!staff.telegramUsername) {
        toast.error('Staff member does not have a Telegram Chat ID configured');
        return;
      }

      // Validate Chat ID format before sending
      if (!/^\d+$/.test(staff.telegramUsername)) {
        toast.error('Invalid Chat ID Format', {
          description: `"${staff.telegramUsername}" is not a valid Chat ID. Chat IDs must be numeric. Please update the staff member's Chat ID.`,
          duration: 7000,
        });
        return;
      }

      const result = await api.sendTelegramTest(staffId);
      
      if (result.success) {
        toast.success(`Test message sent to ${staff.name} on Telegram!`, {
          description: `Sent to Chat ID: ${staff.telegramUsername}`
        });
      }
    } catch (error: any) {
      console.error('Error sending Telegram test:', error);
      
      let errorMessage = error.message || 'Failed to send Telegram test message';
      let description = undefined;
      
      // Provide helpful guidance based on error type
      if (errorMessage.toLowerCase().includes('username')) {
        description = 'Chat IDs must be numeric (e.g., 123456789). Use "Fetch from Bot" in Edit Staff to get the correct ID.';
      } else if (errorMessage.toLowerCase().includes('chat not found')) {
        description = `${staff.name} needs to start a conversation with your Telegram bot first.`;
      } else if (errorMessage.toLowerCase().includes('blocked')) {
        description = `${staff.name} has blocked your bot. Ask them to unblock it.`;
      }
      
      toast.error('Failed to send Telegram test', {
        description: description || errorMessage,
        duration: 7000,
      });
    }
  };

  const adjustPoints = async (staffId: string, pointsChange: number, reason: string) => {
    try {
      const result = await api.adjustPoints(staffId, pointsChange, reason);
      
      if (result.success) {
        const staff = result.staff;
        
        // Update staff members list
        setStaffMembers(prev => prev.map(s => s.id === staffId ? staff : s));
        
        // Update adjustments list
        if (result.adjustment) {
          setPointAdjustments(prev => [...prev, result.adjustment]);
        }
        
        // Update current user if they are the one being adjusted
        if (currentUser?.id === staffId) {
          setCurrentUser(prev => {
            if (!prev) return null;
            return { ...prev, points: staff.points, level: staff.level };
          });
        }
        
        // Show appropriate message
        if (pointsChange > 0) {
          toast.success(`Added ${pointsChange} points to ${staff.name}`, {
            description: reason
          });
          
          // Check for level up
          if (result.leveledUp) {
            toast.success(`🎉 ${staff.name} leveled up to ${staff.level}!`, {
              description: 'New events are now available'
            });
          }
        } else {
          toast.warning(`Deducted ${Math.abs(pointsChange)} points from ${staff.name}`, {
            description: reason
          });
        }
      }
    } catch (error: any) {
      console.error('Error adjusting points:', error);
      toast.error(error.message || 'Failed to adjust points');
    }
  };

  const signUpForEvent = async (eventId: string, staffId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      if (!event) {
        toast.error('Event not found');
        return;
      }

      if (event.signedUpStaff.includes(staffId)) {
        toast.info('You are already signed up for this event');
        return;
      }

      // Check if event is in the past
      const eventDate = new Date(`${event.date}T${event.time}`);
      if (eventDate < new Date()) {
        toast.error('Cannot sign up for past events');
        return;
      }

      const result = await api.signUpForEvent(eventId);
      
      if (result.success && result.event) {
        setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        toast.success(`Successfully signed up for "${event.name}"`, {
          description: `${formatDate(event.date)} at ${event.time}`
        });
      }
    } catch (error: any) {
      console.error('Error signing up for event:', error);
      toast.error(error.message || 'Failed to sign up for event');
    }
  };

  const cancelSignUp = async (eventId: string, staffId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      const result = await api.cancelSignUp(eventId);
      
      if (result.success && result.event) {
        setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        toast.info(`Cancelled sign-up for "${event?.name}"`);
      }
    } catch (error: any) {
      console.error('Error cancelling sign-up:', error);
      toast.error(error.message || 'Failed to cancel sign-up');
    }
  };

  const adminSignUpStaff = async (eventId: string, staffIds: string[]) => {
    try {
      const event = events.find(e => e.id === eventId);
      if (!event) {
        toast.error('Event not found');
        return;
      }

      const result = await api.adminSignUpStaff(eventId, staffIds);
      
      if (result.success && result.event) {
        setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        const staffCount = result.addedCount || staffIds.length;
        toast.success(`Successfully signed up ${staffCount} staff member${staffCount !== 1 ? 's' : ''} for "${event.name}"`);
      }
    } catch (error: any) {
      console.error('Error admin signing up staff:', error);
      toast.error(error.message || 'Failed to sign up staff for event');
    }
  };

  const confirmParticipation = async (eventId: string, staffId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      const staff = staffMembers.find(s => s.id === staffId);
      
      if (!event || !staff) {
        toast.error('Event or staff member not found');
        return;
      }

      const result = await api.confirmParticipation(eventId, staffId);
      
      if (result.success) {
        // Update staff member
        setStaffMembers(prev => prev.map(s => s.id === staffId ? result.staff : s));
        
        // Update event with confirmed staff
        if (result.event) {
          setEvents(prev => prev.map(e => e.id === eventId ? result.event : e));
        }
        
        // Update adjustments
        if (result.adjustment) {
          setPointAdjustments(prev => [...prev, result.adjustment]);
        }
        
        toast.success(`Confirmed participation for ${staff.name}`, {
          description: `Awarded ${event.points} points`
        });
        
        if (result.leveledUp) {
          toast.success(`🎉 ${staff.name} leveled up to ${result.staff.level}!`, {
            description: 'New events are now available'
          });
        }
      }
    } catch (error: any) {
      console.error('Error confirming participation:', error);
      toast.error(error.message || 'Failed to confirm participation');
    }
  };

  const confirmAllParticipants = async (eventId: string) => {
    try {
      const event = events.find(e => e.id === eventId);
      
      if (!event) {
        toast.error('Event not found');
        return;
      }

      const result = await api.confirmAllParticipants(eventId);
      
      if (result.success) {
        // Update all staff members
        setStaffMembers(prev => {
          const updatedMap = new Map(result.staffList.map(s => [s.id, s]));
          return prev.map(s => updatedMap.get(s.id) || s);
        });
        
        // Update the event
        setEvents(prev => prev.map(e => 
          e.id === eventId ? result.event : e
        ));
        
        // Add adjustments
        setPointAdjustments(prev => [...prev, ...result.adjustments]);
        
        toast.success(`Confirmed ${result.confirmedCount} participant${result.confirmedCount !== 1 ? 's' : ''}`, {
          description: `Awarded ${event.points} points to each participant`
        });
        
        // Show level up notifications
        if (result.levelUps && result.levelUps.length > 0) {
          result.levelUps.forEach(levelUp => {
            toast.success(`🎉 ${levelUp.name} leveled up to ${levelUp.newLevel}!`, {
              description: 'New events are now available'
            });
          });
        }
      }
    } catch (error: any) {
      console.error('Error confirming all participants:', error);
      toast.error(error.message || 'Failed to confirm all participants');
    }
  };

  const closeEvent = async (eventId: string, approvedStaffIds: string[]) => {
    try {
      const event = events.find(e => e.id === eventId);
      
      if (!event) {
        toast.error('Event not found');
        return;
      }

      const result = await api.closeEvent(eventId, approvedStaffIds);
      
      if (result.success) {
        // Update the event
        setEvents(prev => prev.map(e => 
          e.id === eventId ? result.event : e
        ));
        
        const approvedCount = approvedStaffIds.length;
        const rejectedCount = event.signedUpStaff.length - approvedCount;
        
        toast.success(`Event closed successfully`, {
          description: `${approvedCount} staff marked as selected`
        });
        
        // Show level up notifications
        if (result.levelUps && result.levelUps.length > 0) {
          result.levelUps.forEach(levelUp => {
            toast.success(`🎉 ${levelUp.name} leveled up to ${levelUp.newLevel}!`, {
              description: 'New events are now available'
            });
          });
        }
      }
    } catch (error: any) {
      console.error('Error closing event:', error);
      toast.error(error.message || 'Failed to close event');
    }
  };

  const initializeDatabase = async () => {
    try {
      setIsLoading(true);
      const result = await api.initialize();
      
      if (result.success) {
        setIsInitialized(true);
        
        // Show credentials in a more visible way
        const adminCreds = result.credentials?.admin;
        const staffCreds = result.credentials?.staff;
        
        toast.success('Database initialized successfully!', {
          description: 'Sample accounts created. Check console for login details.',
          duration: 10000
        });
        
        // Log credentials to console
        console.log('=== DATABASE INITIALIZED ===');
        console.log('Admin Login:', adminCreds);
        console.log('Sample Staff Login:', staffCreds);
        console.log('===========================');
      } else {
        toast.info(result.message || 'Database already initialized');
        setIsInitialized(true);
      }
    } catch (error: any) {
      console.error('Error initializing database:', error);
      toast.error(error.message || 'Failed to initialize database');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <>
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading...</p>
          </div>
        </div>
        <Toaster richColors position="top-center" />
      </>
    );
  }

  // Show initialization screen if database is not initialized
  if (!isInitialized && !currentUser) {
    return (
      <>
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
            <div className="text-center mb-6">
              <h1 className="mb-2">Nahky Araby Event Hub</h1>
              <p className="text-gray-600">
                Welcome! Initialize the database to get started.
              </p>
            </div>
            
            <button
              onClick={initializeDatabase}
              disabled={isLoading}
              className="w-full bg-blue-500 text-white py-3 px-4 rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mb-4"
            >
              {isLoading ? 'Initializing...' : 'Initialize Database'}
            </button>
            
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
              <p className="font-medium text-blue-900 mb-2">This will create:</p>
              <ul className="text-blue-800 space-y-1 text-left list-disc list-inside">
                <li>Admin account for management</li>
                <li>Sample staff members</li>
                <li>Example events</li>
              </ul>
              <p className="text-blue-700 mt-3 text-xs">
                Login credentials will be displayed in the browser console after initialization.
              </p>
            </div>
          </div>
        </div>
        <Toaster richColors position="top-center" />
      </>
    );
  }

  if (!currentUser) {
    return (
      <>
        <LoginScreen onLogin={handleLogin} onPasswordSetup={handlePasswordSetup} />
        <Toaster richColors position="top-center" />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {currentUser.role === 'admin' ? (
        <AdminDashboard
          events={events}
          staffMembers={staffMembers}
          pointAdjustments={pointAdjustments}
          pointTransactions={pointTransactions}
          levels={levels}
          adminEmail={adminEmail}
          adminPhone={adminPhone}
          onAddEvent={addEvent}
          onUpdateEvent={updateEvent}
          onCancelEvent={cancelEvent}
          onReinstateEvent={reinstateEvent}
          onDeleteEvent={deleteEvent}
          onAddStaff={addStaffMember}
          onUpdateStaff={updateStaffMember}
          onDeleteStaff={deleteStaffMember}
          onAdjustPoints={adjustPoints}
          onSendPasswordReset={sendPasswordReset}
          onSendTelegramTest={sendTelegramTest}
          onConfirmParticipation={confirmParticipation}
          onConfirmAllParticipants={confirmAllParticipants}
          onCloseEvent={closeEvent}
          onAdminSignUpStaff={adminSignUpStaff}
          onSaveAdminSettings={saveAdminSettings}
          onAddLevel={addLevel}
          onUpdateLevel={updateLevel}
          onDeleteLevel={deleteLevel}
          onReorderLevel={reorderLevel}
          onWhatsAppConnect={connectWhatsApp}
          whatsAppConnected={whatsAppConnected}
          whatsAppPhoneNumber={whatsAppPhoneNumber}
          onTelegramConnect={connectTelegram}
          telegramConnected={telegramConnected}
          telegramBotName={telegramBotName}
          onLogout={handleLogout}
          onResetData={() => {
            toast.info('Reset functionality not available with Supabase. Please reinitialize if needed.');
          }}
          currentUser={currentUser}
        />
      ) : (
        <StaffDashboard
          events={events}
          levels={levels}
          currentUser={currentUser}
          staffMembers={staffMembers}
          onSignUp={signUpForEvent}
          onCancelSignUp={cancelSignUp}
          onLogout={handleLogout}
        />
      )}
      <Toaster richColors position="top-center" />
    </div>
  );
}

export default App;