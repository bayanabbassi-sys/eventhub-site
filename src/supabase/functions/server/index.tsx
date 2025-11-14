import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as kv from "./kv_store.tsx";

// Helper function to add delay between requests (for rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Email configuration - update this after verifying your domain with Resend
// IMPORTANT: When using 'onboarding@resend.dev', you can ONLY send to 'delivered@resend.dev'
// This is a Resend testing mode restriction
// When you're ready for production, verify a domain at resend.com/domains
// and update this to use your domain email
const FROM_EMAIL = 'onboarding@resend.dev';

// Resend email service
const sendEmail = async (to: string, subject: string, html: string) => {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  
  if (!resendApiKey) {
    console.error('RESEND_API_KEY not configured');
    return { 
      success: false, 
      error: 'Email service not configured. Please set up your Resend API key in the environment variables.' 
    };
  }

  const fromEmail = FROM_EMAIL;
  
  // In testing mode with onboarding@resend.dev, we can only send to delivered@resend.dev
  // So we send to the test address but log the intended recipient
  const isTestMode = fromEmail === 'onboarding@resend.dev';
  const actualRecipient = isTestMode ? 'delivered@resend.dev' : to;
  
  if (isTestMode) {
    console.log(`📧 TEST MODE: Sending email to ${actualRecipient} (intended for: ${to})`);
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [actualRecipient],
        subject: subject,
        html: html,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      // Check if this is a Resend testing mode restriction
      const isTestingRestriction = result.message && 
        (result.message.includes('testing emails') || result.message.includes('verify a domain'));
      
      if (isTestingRestriction) {
        // This is expected behavior in testing mode - use warning instead of error
        console.log('📧 Resend testing mode: Email not sent to', to, '- Manual link will be provided');
        return { 
          success: false, 
          error: 'TESTING_MODE',
          isTestingMode: true
        };
      }
      
      // For other errors, log them properly
      console.error('Resend API error:', result);
      return { success: false, error: result.message || 'Failed to send email' };
    }

    console.log('Email sent successfully:', result.id);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message };
  }
};

const app = new Hono();

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Initialize Supabase client with service role for admin operations
const getSupabaseAdmin = () => {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
};

// Initialize Supabase client for auth operations
const getSupabaseClient = () => {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  );
};

// Helper function to calculate level based on points
const calculateLevel = async (points: number): Promise<string> => {
  try {
    const levels = await kv.getByPrefix('level:');
    
    if (levels.length === 0) {
      return ''; // No levels configured
    }
    
    // Sort levels by minPoints in descending order
    const sortedLevels = levels.sort((a, b) => b.minPoints - a.minPoints);
    
    // Find the highest level that the user qualifies for
    for (const level of sortedLevels) {
      if (points >= level.minPoints) {
        return level.name;
      }
    }
    
    // If no level qualifies, return the lowest level (first in original order)
    const lowestLevel = levels.sort((a, b) => a.order - b.order)[0];
    return lowestLevel?.name || '';
  } catch (error) {
    console.error('Error calculating level:', error);
    return '';
  }
};

// Helper function to verify user authentication
const verifyAuth = async (authHeader: string | null) => {
  if (!authHeader) {
    console.error('Auth verification failed: No authorization header');
    return { error: 'No authorization header', user: null };
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    console.error('Auth verification failed: Invalid authorization header format');
    return { error: 'Invalid authorization header format', user: null };
  }

  console.log('Verifying token:', token.substring(0, 20) + '...');

  const supabase = getSupabaseAdmin();
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error) {
    console.error('Auth verification failed: Supabase error:', error.message);
    return { error: 'Unauthorized', user: null };
  }

  if (!user) {
    console.error('Auth verification failed: No user found');
    return { error: 'Unauthorized', user: null };
  }

  console.log('Auth verification successful for user:', user.id);
  return { error: null, user };
};

// Health check endpoint
app.get("/make-server-08658f87/health", (c) => {
  return c.json({ status: "ok" });
});

// Check if database is initialized
app.get("/make-server-08658f87/status", async (c) => {
  try {
    const events = await kv.getByPrefix('event:');
    const users = await kv.getByPrefix('user:');
    const levels = await kv.getByPrefix('level:');
    
    return c.json({ 
      initialized: users.length > 0,
      eventsCount: events.length,
      usersCount: users.length,
      levelsCount: levels.length
    });
  } catch (error) {
    console.error('Status check error:', error);
    return c.json({ initialized: false, error: 'Failed to check status' }, 500);
  }
});

// Get email configuration
app.get("/make-server-08658f87/email-config", (c) => {
  const isTestMode = FROM_EMAIL === 'onboarding@resend.dev';
  return c.json({ 
    fromEmail: FROM_EMAIL,
    isTestMode
  });
});

// ==================== AUTH ENDPOINTS ====================

// Sign up new staff member
app.post("/make-server-08658f87/signup", async (c) => {
  try {
    const { email, password, name, role = 'staff' } = await c.req.json();

    if (!email || !password || !name) {
      return c.json({ error: 'Email, password, and name are required' }, 400);
    }

    const supabase = getSupabaseAdmin();

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { 
        name, 
        role,
        points: 0,
        level: ''
      },
      // Automatically confirm the user's email since an email server hasn't been configured.
      email_confirm: true
    });

    if (authError) {
      console.error('Auth signup error:', authError);
      return c.json({ error: authError.message }, 400);
    }

    // Create staff member record
    const staffMember = {
      id: authData.user.id,
      email,
      name,
      points: 0,
      level: '',
      status: role === 'admin' ? 'active' : 'pending',
      role,
      createdAt: new Date().toISOString()
    };

    await kv.set(`user:${authData.user.id}`, staffMember);

    return c.json({ 
      success: true, 
      user: staffMember 
    });
  } catch (error) {
    console.error('Signup error:', error);
    return c.json({ error: 'Failed to create user' }, 500);
  }
});

// Login endpoint
app.post("/make-server-08658f87/login", async (c) => {
  try {
    const { email, password } = await c.req.json();

    console.log('Login attempt for:', email);

    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400);
    }

    const supabase = getSupabaseClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      // Only log as info, not error - invalid credentials are expected for non-demo accounts
      console.log('Login failed for', email, '- This is normal if not using demo accounts');
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    console.log('Login successful for user:', data.user.id);

    // Fetch user details from KV store
    const userData = await kv.get(`user:${data.user.id}`);
    console.log('User data from KV:', userData ? 'found' : 'not found');

    // Check if user is logging in with a temporary password (invitation or reset)
    // Temporary passwords start with 'temp' or 'reset'
    const isTempPassword = password.startsWith('temp') || password.startsWith('reset');
    
    if (isTempPassword && userData && userData.status === 'pending') {
      // User needs to set up a new password (invitation flow)
      console.log('User logging in with invitation temp password - requires password setup');
      return c.json({
        success: true,
        needsPasswordSetup: true,
        email: email,
        tempPassword: password
      });
    }
    
    if (isTempPassword && userData && userData.status === 'active') {
      // User is logging in with a reset password - also needs password setup
      console.log('User logging in with reset temp password - requires password setup');
      return c.json({
        success: true,
        needsPasswordSetup: true,
        email: email,
        tempPassword: password
      });
    }

    return c.json({
      success: true,
      accessToken: data.session.access_token,
      user: userData || {
        id: data.user.id,
        email: data.user.email,
        name: data.user.user_metadata.name,
        role: data.user.user_metadata.role || 'staff',
        points: data.user.user_metadata.points || 0,
        level: data.user.user_metadata.level || ''
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Failed to login' }, 500);
  }
});

// ==================== EVENT ENDPOINTS ====================

// Get all events
app.get("/make-server-08658f87/events", async (c) => {
  try {
    console.log('GET /events - Fetching events');
    const authHeader = c.req.header('Authorization');
    console.log('GET /events - Auth header:', authHeader ? authHeader.substring(0, 30) + '...' : 'MISSING');
    
    const { error: authError } = await verifyAuth(authHeader);
    
    if (authError) {
      console.error('GET /events - Auth failed:', authError);
      return c.json({ error: authError }, 401);
    }

    const events = await kv.getByPrefix('event:');
    console.log('GET /events - Fetched', events.length, 'events');
    return c.json({ events });
  } catch (error) {
    console.error('Error fetching events:', error);
    return c.json({ error: 'Failed to fetch events' }, 500);
  }
});

// Create new event
app.post("/make-server-08658f87/events", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const eventData = await c.req.json();
    // Generate unique ID using timestamp + random string to prevent duplicates
    const eventId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    const event = {
      id: eventId,
      ...eventData,
      // Default status to 'draft' if not provided
      status: eventData.status || 'draft',
      signedUpStaff: [],
      createdAt: new Date().toISOString()
    };

    await kv.set(`event:${eventId}`, event);

    // Only send email notifications if the event status is 'open'
    // Draft and closed events should not trigger notifications
    if (event.status === 'open') {
      try {
        // Get all staff members and levels
        const allUsers = await kv.getByPrefix('user:');
        const staffMembers = allUsers.filter(u => u.role === 'staff' && u.status === 'active');
        const levels = await kv.getByPrefix('level:');
        
        console.log(`📧 Event notification system: Found ${staffMembers.length} active staff members out of ${allUsers.length} total users`);
        console.log(`📧 Staff members:`, staffMembers.map(s => ({ name: s.name, level: s.level, telegramChatId: (s.telegramChatId || s.telegramUsername) ? 'SET' : 'NOT SET' })));
        
        // Sort levels by order (lower order = higher in hierarchy)
        const sortedLevels = levels.sort((a, b) => a.order - b.order);
        
        // Find the event's required level
        const eventLevel = sortedLevels.find(l => l.name === event.requiredLevel);
        
        if (!eventLevel) {
          console.log(`⚠️ Event level "${event.requiredLevel}" not found in system`);
        }
        
        if (eventLevel && staffMembers.length > 0) {
        // Filter staff who can access this event
        // Staff can access if their level order >= event level order (same or below in list)
        const eligibleStaff = staffMembers.filter(staff => {
          if (!staff.level) {
            console.log(`  - ${staff.name}: No level assigned`);
            return false;
          }
          const staffLevel = sortedLevels.find(l => l.name === staff.level);
          // Staff with order >= event order can access (they are at same level or higher in hierarchy)
          const canAccess = staffLevel && staffLevel.order >= eventLevel.order;
          console.log(`  - ${staff.name} (${staff.level}, order: ${staffLevel?.order}): ${canAccess ? '✓ Eligible' : '✗ Not eligible'}`);
          return canAccess;
        });
        
        // Skip email notifications for event creation (only Telegram will be used)
        console.log(`ℹ️ Skipping email notifications for event creation (only Telegram notifications will be sent)`);
        
        // Email loop removed - only Telegram notifications for new events
        /*
        for (let i = 0; i < eligibleStaff.length; i++) {
          const staff = eligibleStaff[i];
          const emailHtml = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .event-details { background-color: white; padding: 25px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10B981; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
                .detail-row { margin: 15px 0; display: flex; }
                .detail-icon { width: 24px; margin-right: 10px; color: #6B7280; }
                .detail-label { color: #6B7280; font-weight: bold; margin-right: 8px; }
                .detail-value { color: #1F2937; }
                .cta-button { display: inline-block; background-color: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-weight: bold; }
                .footer { text-align: center; margin-top: 20px; color: #666; font-size: 14px; }
                .level-badge { display: inline-block; background-color: #EFF6FF; color: #3B82F6; padding: 4px 12px; border-radius: 12px; font-size: 14px; font-weight: bold; }
                .points-badge { display: inline-block; background-color: #FEF3C7; color: #F59E0B; padding: 4px 12px; border-radius: 12px; font-size: 14px; font-weight: bold; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div style="text-align: center; margin-bottom: 10px;">
                    <img src="https://img1.wsimg.com/isteam/ip/aead55c7-5dc3-4ad4-8132-6139ccf3e033/nahky.png/:/rs=w:132,h:104,cg:true,m/cr=w:132,h:104/qt=q:95" alt="Nahky Araby Logo" style="max-width: 200px; height: auto;" />
                  </div>
                  <h2 style="margin: 10px 0 20px 0; font-size: 24px; font-weight: 600; opacity: 1;">Nahky Araby Event Hub</h2>
                  <h1>🎉 New Event Available!</h1>
                </div>
                <div class="content">
                  <h2>Hello ${staff.name},</h2>
                  <p>A new event has been posted that you're eligible to attend!</p>
                  
                  <div class="event-details">
                    <h3 style="margin-top: 0; color: #10B981;">📅 ${event.name}</h3>
                    
                    <div class="detail-row">
                      <span class="detail-icon">📍</span>
                      <div>
                        <span class="detail-label">Location:</span>
                        <span class="detail-value">${event.location}</span>
                      </div>
                    </div>
                    
                    <div class="detail-row">
                      <span class="detail-icon">📆</span>
                      <div>
                        <span class="detail-label">Date:</span>
                        <span class="detail-value">${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
                      </div>
                    </div>
                    
                    <div class="detail-row">
                      <span class="detail-icon">🕐</span>
                      <div>
                        <span class="detail-label">Time:</span>
                        <span class="detail-value">${event.time}</span>
                      </div>
                    </div>
                    
                    <div class="detail-row">
                      <span class="detail-icon">⏱️</span>
                      <div>
                        <span class="detail-label">Duration:</span>
                        <span class="detail-value">${event.duration}</span>
                      </div>
                    </div>
                    
                    <div class="detail-row">
                      <span class="detail-icon">🎯</span>
                      <div>
                        <span class="detail-label">Required Level:</span>
                        <span class="level-badge">${event.requiredLevel}</span>
                      </div>
                    </div>
                    
                    <div class="detail-row">
                      <span class="detail-icon">⭐</span>
                      <div>
                        <span class="detail-label">Points:</span>
                        <span class="points-badge">${event.points} points</span>
                      </div>
                    </div>
                  </div>
                  
                  <p style="text-align: center;">
                    <a href="#" class="cta-button">Sign Up Now</a>
                  </p>
                  
                  <p style="color: #6B7280; font-size: 14px;">Log in to Nahky Araby Event Hub to sign up for this event and start earning points!</p>
                </div>
                <div class="footer">
                  <p>This is an automated notification. Please do not reply to this email.</p>
                </div>
              </div>
            </body>
            </html>
          `;
          
          const emailResult = await sendEmail(
            staff.email,
            `New Event Available: ${event.name}`,
            emailHtml
          );
          
          if (emailResult.success) {
            console.log(`  ✓ Email sent to ${staff.name} (${staff.email})`);
          } else {
            console.log(`  ✗ Failed to send email to ${staff.name}: ${emailResult.error}`);
          }
          
          // Rate limiting: Wait 600ms between emails (Resend allows 2 per second)
          // Only wait if this is not the last email
          if (i < eligibleStaff.length - 1) {
            await delay(600);
          }
        }
        */
        
        // Send WhatsApp notifications if WhatsApp is connected
        const whatsAppSettings = await kv.get('whatsapp:settings');
        if (whatsAppSettings && whatsAppSettings.connected) {
          console.log(`📱 WhatsApp is connected, sending notifications to ${eligibleStaff.length} staff members`);
          
          for (let i = 0; i < eligibleStaff.length; i++) {
            const staff = eligibleStaff[i];
            
            // Check if staff member has a phone number
            if (!staff.phone || staff.phone.trim() === '') {
              console.log(`  ⚠️ ${staff.name}: No phone number on file, skipping WhatsApp`);
              continue;
            }
            
            // Format WhatsApp message
            const whatsAppMessage = `🎉 *New Event Available!*

Hello ${staff.name},

A new event has been posted that you're eligible to attend:

📅 *${event.name}*
📍 Location: ${event.location}
📆 Date: ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Time: ${event.time}
⏱️ Duration: ${event.duration}
🎯 Required Level: ${event.requiredLevel}
⭐ Points: ${event.points} points

Log in to Nahky Araby Event Hub to sign up for this event and start earning points!`;
            
            const whatsAppResult = await sendWhatsAppMessage(staff.phone, whatsAppMessage);
            
            if (whatsAppResult.success) {
              console.log(`  ✓ WhatsApp sent to ${staff.name} (${staff.phone})`);
            } else {
              console.log(`  ✗ Failed to send WhatsApp to ${staff.name}: ${whatsAppResult.error}`);
            }
            
            // Rate limiting: Wait 600ms between messages to avoid API limits
            if (i < eligibleStaff.length - 1) {
              await delay(600);
            }
          }
          
          console.log(`✅ Finished sending WhatsApp notifications`);
        } else {
          console.log(`📱 WhatsApp not connected, skipping WhatsApp notifications`);
        }
        
        // Send Telegram notifications if Telegram is connected
        const telegramSettings = await kv.get('telegram:settings');
        console.log(`✈️ Telegram settings:`, telegramSettings ? { connected: telegramSettings.connected, botName: telegramSettings.botName } : 'NOT CONFIGURED');
        
        if (telegramSettings && telegramSettings.connected) {
          console.log(`✈️ Telegram is connected, checking ${eligibleStaff.length} eligible staff members for Telegram notifications`);
          
          let telegramSentCount = 0;
          for (let i = 0; i < eligibleStaff.length; i++) {
            const staff = eligibleStaff[i];
            
            // Check if staff member has a Telegram chat ID (check both fields for backwards compatibility)
            const chatId = staff.telegramChatId || staff.telegramUsername;
            if (!chatId || chatId.trim() === '') {
              console.log(`  ⚠️ ${staff.name}: No Telegram chat ID on file, skipping Telegram`);
              continue;
            }
            
            console.log(`  📤 Attempting to send Telegram to ${staff.name} (Chat ID: ${chatId})...`);
            
            // Format Telegram message
            const telegramMessage = `🎉 *New Event Available!*

Hello ${staff.name},

A new event has been posted that you're eligible to attend:

📅 *${event.name}*
📍 Location: ${event.location}
📆 Date: ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Time: ${event.time}
⏱️ Duration: ${event.duration}
🎯 Required Level: ${event.requiredLevel}
⭐ Points: ${event.points} points${event.description ? `

📝 Description: ${event.description}` : ''}${event.notes ? `

💬 Notes: ${event.notes}` : ''}

Log in to Nahky Araby Event Hub to sign up for this event and start earning points!`;
            
            const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
            
            if (telegramResult.success) {
              console.log(`  ✓ Telegram sent successfully to ${staff.name} (${chatId})`);
              telegramSentCount++;
            } else {
              console.log(`  ✗ Failed to send Telegram to ${staff.name} (${chatId}): ${telegramResult.error}`);
            }
            
            // Rate limiting: Wait 600ms between messages to avoid API limits
            if (i < eligibleStaff.length - 1) {
              await delay(600);
            }
          }
          
          console.log(`✅ Finished sending Telegram notifications: ${telegramSentCount} sent successfully`);
        } else {
          console.log(`✈️ Telegram not connected, skipping Telegram notifications`);
        }
      }
      } catch (emailError) {
        // Log email error but don't fail the event creation
        console.error('Error sending event notification emails:', emailError);
      }
    } else {
      console.log(`ℹ️ Event status is "${event.status}", skipping notifications (only 'open' events trigger notifications)`);
    }

    return c.json({ success: true, event });
  } catch (error) {
    console.error('Error creating event:', error);
    return c.json({ error: 'Failed to create event' }, 500);
  }
});

// Update event
app.put("/make-server-08658f87/events/:id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const eventId = c.req.param('id');
    const eventData = await c.req.json();

    // Get existing event
    const existingEvent = await kv.get(`event:${eventId}`);
    if (!existingEvent) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Update event while preserving signedUpStaff, confirmedStaff, hasBeenClosedBefore, and createdAt
    const updatedEvent = {
      ...existingEvent,
      ...eventData,
      id: eventId,
      signedUpStaff: existingEvent.signedUpStaff,
      confirmedStaff: existingEvent.confirmedStaff,
      hasBeenClosedBefore: existingEvent.hasBeenClosedBefore,
      createdAt: existingEvent.createdAt
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    // Send notifications based on event status
    try {
      const eventStatus = updatedEvent.status || 'open';
    
      if (eventStatus !== 'draft') {
        console.log(`📢 Event updated with status "${eventStatus}", checking for changes to notify staff...`);
        
        // First, check for selection/deselection changes
        const oldConfirmedStaff = existingEvent.confirmedStaff || [];
        const newConfirmedStaff = updatedEvent.confirmedStaff || [];
        
        // Calculate who was selected and deselected
        const newlySelected = newConfirmedStaff.filter((id: string) => !oldConfirmedStaff.includes(id));
        const newlyDeselected = oldConfirmedStaff.filter((id: string) => !newConfirmedStaff.includes(id));
        
        const hasSelectionChanges = newlySelected.length > 0 || newlyDeselected.length > 0;
        
        if (hasSelectionChanges) {
          console.log(`👥 Selection changes detected: ${newlySelected.length} newly selected, ${newlyDeselected.length} newly deselected`);
          
          // Send selection/deselection notifications
          const telegramSettings = await kv.get('telegram:settings');
          
          if (telegramSettings && telegramSettings.connected) {
            console.log(`✈️ Sending selection change notifications via Telegram`);
            
            // Send selection notifications
            for (let i = 0; i < newlySelected.length; i++) {
              const staffId = newlySelected[i];
              const staff = await kv.get(`user:${staffId}`);
              
              if (!staff) {
                console.log(`  ⚠️ Staff ${staffId}: Not found, skipping`);
                continue;
              }
              
              const chatId = staff.telegramChatId || staff.telegramUsername;
              if (!chatId || chatId.trim() === '') {
                console.log(`  ⚠️ ${staff.name}: No Telegram chat ID, skipping`);
                continue;
              }
              
              const telegramMessage = `Hello ${staff.name},

🎉 *Congratulations!* 🎉

You have been selected to participate in the following event:

📅 *${updatedEvent.name}*
📍 Location: ${updatedEvent.location}
📆 Date: ${new Date(updatedEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Time: ${updatedEvent.time}
⭐ Points: ${updatedEvent.points} points${updatedEvent.description ? `

📝 Description: ${updatedEvent.description}` : ''}${updatedEvent.notes ? `

💬 Notes: ${updatedEvent.notes}` : ''}

We look forward to seeing you there! You will receive your points after the event is completed.`;
              
              const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
              
              if (telegramResult.success) {
                console.log(`  ✓ Selection notification sent to ${staff.name}`);
              } else {
                console.log(`  ✗ Failed to send selection notification to ${staff.name}: ${telegramResult.error}`);
              }
              
              // Rate limiting
              if (i < newlySelected.length - 1 || newlyDeselected.length > 0) {
                await delay(600);
              }
            }
            
            // Send deselection notifications
            for (let i = 0; i < newlyDeselected.length; i++) {
              const staffId = newlyDeselected[i];
              const staff = await kv.get(`user:${staffId}`);
              
              if (!staff) {
                console.log(`  ⚠️ Staff ${staffId}: Not found, skipping`);
                continue;
              }
              
              const chatId = staff.telegramChatId || staff.telegramUsername;
              if (!chatId || chatId.trim() === '') {
                console.log(`  ⚠️ ${staff.name}: No Telegram chat ID, skipping`);
                continue;
              }
              
              const telegramMessage = `Hello ${staff.name},

Thank you for your interest in the following event:

📅 *${updatedEvent.name}*
📆 Date: ${new Date(updatedEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Unfortunately, you have not been selected for this event. We appreciate your participation and hope to see you at future events!`;
              
              const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
              
              if (telegramResult.success) {
                console.log(`  ✓ Deselection notification sent to ${staff.name}`);
              } else {
                console.log(`  ✗ Failed to send deselection notification to ${staff.name}: ${telegramResult.error}`);
              }
              
              // Rate limiting
              if (i < newlyDeselected.length - 1) {
                await delay(600);
              }
            }
            
            console.log(`✅ Sent ${newlySelected.length + newlyDeselected.length} selection change notification(s)`);
          } else {
            console.log(`✈️ Telegram not connected, skipping selection change notifications`);
          }
        }
        
        // Then, detect changes between existing and updated event
        const changes: string[] = [];
        
        if (existingEvent.name !== updatedEvent.name) {
          changes.push(`Name: "${existingEvent.name}" → "${updatedEvent.name}"`);
        }
        if (existingEvent.date !== updatedEvent.date) {
          const oldDate = new Date(existingEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          const newDate = new Date(updatedEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          changes.push(`Date: ${oldDate} → ${newDate}`);
        }
        if (existingEvent.time !== updatedEvent.time) {
          changes.push(`Time: ${existingEvent.time} → ${updatedEvent.time}`);
        }
        if (existingEvent.location !== updatedEvent.location) {
          changes.push(`Location: "${existingEvent.location}" → "${updatedEvent.location}"`);
        }
        if (existingEvent.duration !== updatedEvent.duration) {
          changes.push(`Duration: ${existingEvent.duration} → ${updatedEvent.duration}`);
        }
        if (existingEvent.points !== updatedEvent.points) {
          changes.push(`Points: ${existingEvent.points} → ${updatedEvent.points}`);
        }
        if (existingEvent.requiredLevel !== updatedEvent.requiredLevel) {
          changes.push(`Required Level: ${existingEvent.requiredLevel} → ${updatedEvent.requiredLevel}`);
        }
        if (existingEvent.description !== updatedEvent.description) {
          changes.push(`Description updated`);
        }
        if (existingEvent.notes !== updatedEvent.notes) {
          changes.push(`Notes updated`);
        }
        
        if (changes.length > 0) {
          console.log(`✏️ Detected ${changes.length} change(s):`, changes);
          
          // Determine which staff to notify based on status
          let staffToNotify: string[] = [];
          
          if (eventStatus === 'open') {
            // Notify staff who are participating (signed up)
            staffToNotify = updatedEvent.signedUpStaff || [];
            console.log(`📋 Event is OPEN - notifying ${staffToNotify.length} participating staff`);
          } else if (eventStatus === 'closed') {
            // Notify staff who are selected (confirmed)
            staffToNotify = updatedEvent.confirmedStaff || [];
            console.log(`🔒 Event is CLOSED - notifying ${staffToNotify.length} selected staff`);
          }
          
          if (staffToNotify.length > 0) {
          // Check if Telegram is connected
          const telegramSettings = await kv.get('telegram:settings');
          
          if (telegramSettings && telegramSettings.connected) {
            console.log(`✈️ Telegram connected, sending update notifications to ${staffToNotify.length} staff members`);
            
            let notificationsSent = 0;
            
            for (let i = 0; i < staffToNotify.length; i++) {
              const staffId = staffToNotify[i];
              const staff = await kv.get(`user:${staffId}`);
              
              if (!staff) {
                console.log(`  ⚠️ Staff member ${staffId} not found, skipping`);
                continue;
              }
              
              const chatId = staff.telegramChatId || staff.telegramUsername;
              if (!chatId || chatId.trim() === '') {
                console.log(`  ⚠️ ${staff.name}: No Telegram chat ID, skipping`);
                continue;
              }
              
              // Format the changes list
              const changesText = changes.map((change, idx) => `${idx + 1}. ${change}`).join('\n');
              
              const telegramMessage = `📝 *Event Updated*

Hello ${staff.name},

An event you're ${eventStatus === 'open' ? 'signed up for' : 'selected for'} has been updated:

*${updatedEvent.name}*

*Changes Made:*
${changesText}

*Current Event Details:*
📍 Location: ${updatedEvent.location}
📆 Date: ${new Date(updatedEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Time: ${updatedEvent.time}
⏱️ Duration: ${updatedEvent.duration}
⭐ Points: ${updatedEvent.points}

Please make note of these changes. Log in to the app for full details.`;

              const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
              
              if (telegramResult.success) {
                console.log(`  ✓ Update notification sent to ${staff.name}`);
                notificationsSent++;
              } else {
                console.log(`  ✗ Failed to send update notification to ${staff.name}: ${telegramResult.error}`);
              }
              
              // Rate limiting
              if (i < staffToNotify.length - 1) {
                await delay(600);
              }
            }
            
            console.log(`✅ Sent ${notificationsSent} update notification(s)`);
          } else {
            console.log(`✈️ Telegram not connected, skipping update notifications`);
          }
        } else {
          console.log(`ℹ️ No staff to notify (event status: ${eventStatus})`);
        }
      } else {
        console.log(`ℹ️ No significant event detail changes detected, skipping detail update notifications`);
      }
    } else {
      console.log(`ℹ️ Event status is "draft", skipping update notifications`);
    }
    } catch (notificationError) {
      console.error('Error sending event update notifications:', notificationError);
    }

    return c.json({ success: true, event: updatedEvent });
  } catch (error) {
    console.error('Error updating event:', error);
    return c.json({ error: 'Failed to update event' }, 500);
  }
});

// Cancel event
app.post("/make-server-08658f87/events/:id/cancel", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const eventId = c.req.param('id');

    // Get existing event
    const existingEvent = await kv.get(`event:${eventId}`);
    if (!existingEvent) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Update event status to cancelled
    const cancelledEvent = {
      ...existingEvent,
      status: 'cancelled'
    };

    await kv.set(`event:${eventId}`, cancelledEvent);

    // Send notifications to participating staff members
    try {
      if (cancelledEvent.signedUpStaff && cancelledEvent.signedUpStaff.length > 0) {
        console.log(`📧 Sending cancellation notifications for event: ${cancelledEvent.name}`);
        
        // Get all staff members who signed up
        const allUsers = await kv.getByPrefix('user:');
        const participatingStaff = allUsers.filter(u => 
          cancelledEvent.signedUpStaff.includes(u.id)
        );

        console.log(`Found ${participatingStaff.length} participating staff members`);

        // Send email notifications
        let emailsSent = 0;
        for (let i = 0; i < participatingStaff.length; i++) {
          const staff = participatingStaff[i];
          
          const emailHtml = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #DC2626; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                .event-details { background-color: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #DC2626; }
                .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #6b7280; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div style="text-align: center; margin-bottom: 10px;">
                    <img src="https://img1.wsimg.com/isteam/ip/aead55c7-5dc3-4ad4-8132-6139ccf3e033/nahky.png/:/rs=w:132,h:104,cg:true,m/cr=w:132,h:104/qt=q:95" alt="Nahky Araby Logo" style="max-width: 200px; height: auto;" />
                  </div>
                  <h2 style="margin: 10px 0 20px 0; font-size: 24px; font-weight: 600; opacity: 1;">Nahky Araby Event Hub</h2>
                  <h1>⚠️ Event Cancelled</h1>
                </div>
                <div class="content">
                  <p>Hello ${staff.name},</p>
                  
                  <p>We regret to inform you that the following event has been cancelled:</p>
                  
                  <div class="event-details">
                    <h2 style="margin-top: 0; color: #DC2626;">${cancelledEvent.name}</h2>
                    <p><strong>📅 Date:</strong> ${new Date(cancelledEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
                    <p><strong>🕐 Time:</strong> ${cancelledEvent.time}</p>
                    <p><strong>📍 Location:</strong> ${cancelledEvent.location}</p>
                  </div>
                  
                  <p>We apologize for any inconvenience this may cause. Please check the app for other upcoming events you can participate in.</p>
                  
                  <div class="footer">
                    <p>If you have any questions, please contact the administration team.</p>
                  </div>
                </div>
              </div>
            </body>
            </html>
          `;

          try {
            const resendApiKey = Deno.env.get('RESEND_API_KEY');
            if (resendApiKey) {
              const emailResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${resendApiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  from: 'Nahky Araby Event Hub <onboarding@resend.dev>',
                  to: staff.email,
                  subject: `Event Cancelled: ${cancelledEvent.name}`,
                  html: emailHtml,
                }),
              });

              if (emailResponse.ok) {
                emailsSent++;
                console.log(`  ✓ Email sent to ${staff.name} (${staff.email})`);
              } else {
                console.log(`  ✗ Failed to send email to ${staff.name}`);
              }
            }
          } catch (emailError) {
            console.error(`Error sending email to ${staff.name}:`, emailError);
          }

          // Rate limiting: Wait 600ms between emails
          if (i < participatingStaff.length - 1) {
            await delay(600);
          }
        }

        console.log(`✅ Sent ${emailsSent} cancellation emails`);

        // Send Telegram notifications
        const telegramSettings = await kv.get('telegram:settings');
        console.log(`✈️ Telegram settings for cancellation:`, telegramSettings ? { connected: telegramSettings.connected, botName: telegramSettings.botName } : 'NOT CONFIGURED');
        
        if (telegramSettings && telegramSettings.connected) {
          console.log(`✈️ Telegram is connected, sending cancellation notifications to ${participatingStaff.length} staff members`);
          
          let telegramSentCount = 0;
          for (let i = 0; i < participatingStaff.length; i++) {
            const staff = participatingStaff[i];
            
            // Check if staff member has a Telegram chat ID (check both fields for backwards compatibility)
            const chatId = staff.telegramChatId || staff.telegramUsername;
            if (!chatId || chatId.trim() === '') {
              console.log(`  ⚠️ ${staff.name}: No Telegram chat ID on file, skipping Telegram`);
              continue;
            }
            
            console.log(`  📤 Attempting to send Telegram to ${staff.name} (Chat ID: ${chatId})...`);
            
            // Format Telegram message
            const telegramMessage = `⚠️ *Event Cancelled*

Hello ${staff.name},

We regret to inform you that the following event has been cancelled:

📅 *${cancelledEvent.name}*
📍 Location: ${cancelledEvent.location}
📆 Date: ${new Date(cancelledEvent.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Time: ${cancelledEvent.time}${cancelledEvent.description ? `

📝 Description: ${cancelledEvent.description}` : ''}${cancelledEvent.notes ? `

💬 Notes: ${cancelledEvent.notes}` : ''}

We apologize for any inconvenience. Please check the app for other upcoming events you can participate in.`;
            
            const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
            
            if (telegramResult.success) {
              console.log(`  ✓ Telegram sent successfully to ${staff.name} (${chatId})`);
              telegramSentCount++;
            } else {
              console.log(`  ✗ Failed to send Telegram to ${staff.name} (${chatId}): ${telegramResult.error}`);
            }
            
            // Rate limiting: Wait 600ms between messages
            if (i < participatingStaff.length - 1) {
              await delay(600);
            }
          }
          
          console.log(`✅ Finished sending Telegram cancellation notifications: ${telegramSentCount} sent successfully`);
        }
        
        // After sending all notifications, remove all participants from the event
        console.log(`🔄 Removing all ${cancelledEvent.signedUpStaff.length} participants from cancelled event`);
        cancelledEvent.signedUpStaff = [];
        await kv.set(`event:${eventId}`, cancelledEvent);
        console.log(`✅ All participants removed from event`);
      }
    } catch (notificationError) {
      console.error('Error sending cancellation notifications:', notificationError);
      // Don't fail the cancellation if notifications fail
    }

    return c.json({ success: true, event: cancelledEvent });
  } catch (error) {
    console.error('Error cancelling event:', error);
    return c.json({ error: 'Failed to cancel event' }, 500);
  }
});

// Reinstate event
app.post("/make-server-08658f87/events/:id/reinstate", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const eventId = c.req.param('id');

    // Get existing event
    const existingEvent = await kv.get(`event:${eventId}`);
    if (!existingEvent) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Update event status back to upcoming
    const reinstatedEvent = {
      ...existingEvent,
      status: 'upcoming'
    };

    await kv.set(`event:${eventId}`, reinstatedEvent);

    console.log(`✅ Event "${reinstatedEvent.name}" has been reinstated`);

    return c.json({ success: true, event: reinstatedEvent });
  } catch (error) {
    console.error('Error reinstating event:', error);
    return c.json({ error: 'Failed to reinstate event' }, 500);
  }
});

// Delete event
app.delete("/make-server-08658f87/events/:id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const eventId = c.req.param('id');
    await kv.del(`event:${eventId}`);

    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting event:', error);
    return c.json({ error: 'Failed to delete event' }, 500);
  }
});

// ==================== STAFF ENDPOINTS ====================

// Get all staff members
app.get("/make-server-08658f87/staff", async (c) => {
  try {
    console.log('GET /staff - Fetching staff');
    const authHeader = c.req.header('Authorization');
    console.log('GET /staff - Auth header:', authHeader ? authHeader.substring(0, 30) + '...' : 'MISSING');
    
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      console.error('GET /staff - Auth failed:', authError);
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    const users = await kv.getByPrefix('user:');
    const staff = users.filter(u => u.role === 'staff' || !u.role);
    console.log('GET /staff - Fetched', staff.length, 'staff members');
    
    return c.json({ staff });
  } catch (error) {
    console.error('Error fetching staff:', error);
    return c.json({ error: 'Failed to fetch staff' }, 500);
  }
});

// Invite new staff member (admin only)
app.post("/make-server-08658f87/staff/invite", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { email, name, phone, appUrl } = await c.req.json();

    if (!email || !name) {
      return c.json({ error: 'Email and name are required' }, 400);
    }

    // Check if email already exists
    const existingUsers = await kv.getByPrefix('user:');
    const emailExists = existingUsers.some(u => u.email === email);
    
    if (emailExists) {
      return c.json({ error: 'A staff member with this email already exists' }, 400);
    }

    // Generate temporary password
    const tempPassword = `temp${Math.random().toString(36).slice(2, 10)}`;

    const supabase = getSupabaseAdmin();

    // Create user in Supabase Auth
    const { data: authData, error: signupError } = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      user_metadata: { 
        name,
        role: 'staff',
        points: 0,
        level: ''
      },
      // Automatically confirm the user's email since an email server hasn't been configured.
      email_confirm: true
    });

    if (signupError) {
      console.error('Error creating staff user:', signupError);
      return c.json({ error: signupError.message }, 400);
    }

    const staffMember = {
      id: authData.user.id,
      email,
      name,
      phone: phone || '',
      points: 0,
      level: '',
      status: 'pending',
      role: 'staff',
      createdAt: new Date().toISOString()
    };

    await kv.set(`user:${authData.user.id}`, staffMember);

    // Send invitation email
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .credentials { background-color: white; padding: 25px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10B981; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
          .credential-row { margin: 15px 0; }
          .credential-label { color: #6B7280; font-size: 14px; margin-bottom: 5px; }
          .credential-value { background-color: #F3F4F6; padding: 10px 15px; border-radius: 6px; font-family: monospace; font-size: 16px; color: #1F2937; border: 1px solid #E5E7EB; }
          .footer { text-align: center; margin-top: 20px; color: #666; font-size: 14px; }
          .warning-box { background-color: #FEF3C7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #F59E0B; }
          .info-box { background-color: #EFF6FF; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3B82F6; }
          .arabic-section { direction: rtl; text-align: right; }
          .divider { border-top: 2px solid #E5E7EB; margin: 40px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div style="text-align: center; margin-bottom: 10px;">
              <img src="https://img1.wsimg.com/isteam/ip/aead55c7-5dc3-4ad4-8132-6139ccf3e033/nahky.png/:/rs=w:132,h:104,cg:true,m/cr=w:132,h:104/qt=q:95" alt="Nahky Araby Logo" style="max-width: 200px; height: auto;" />
            </div>
            <h2 style="margin: 10px 0 20px 0; font-size: 24px; font-weight: 600; opacity: 1;">Nahky Araby Event Hub</h2>
            <h1>بريد الدعوة</h1>
          </div>
          <div class="content arabic-section">
            <h2>مرحبا بكم في تطبيق مركز فعاليات نحكي عربي!</h2>
            <h3>مرحبا ${name}،</h3>
            <p>لقد تمت دعوتك للانضمام إلى منصّة إدارة الموظفين. سيساعدك هذا التطبيق على تنظيم مشاركاتك في الفعاليات ومتابعة تقدّمك.</p>
            
            <div class="credentials">
              <h3 style="margin-top: 0; color: #10B981;">🔐 بيانات الدخول الخاصة بك</h3>
              <div class="credential-row">
                <div class="credential-label">اسم المستخدم (البريد الإلكتروني)</div>
                <div class="credential-value" style="direction: ltr; text-align: left;">${email}</div>
              </div>
              <div class="credential-row">
                <div class="credential-label">كلمة المرور المؤقتة</div>
                <div class="credential-value" style="direction: ltr; text-align: left;">${tempPassword}</div>
              </div>
            </div>
            
            <div class="warning-box">
              <strong>⚠️ تنبيه مهم – أول تسجيل دخول</strong>
              <p style="margin: 10px 0 0 0;">عند تسجيل الدخول للمرة الأولى باستخدام هذه البيانات، سيُطلب منك إنشاء كلمة مرور جديدة وآمنة قبل الوصول إلى حسابك.</p>
            </div>
            
            <div class="info-box">
              <h3 style="margin-top: 0;">📋 الخطوات التالية</h3>
              <ol style="margin: 10px 0; padding-right: 20px;">
                <li>زيارة صفحة تسجيل الدخول لتطبيق إدارة الموظفين</li>
                <li>إدخال بريدك الإلكتروني وكلمة المرور المؤقتة</li>
                <li>إنشاء كلمة مرور جديدة وآمنة</li>
                <li>البدء بإدارة فعالياتك وتتبع تقدّمك!</li>
              </ol>
            </div>
            
            <div class=\"info-box\" style=\"background-color: #DBEAFE;\">
              <h3 style=\"margin-top: 0;\">✈️ إعداد إشعارات تيليغرام</h3>
              <p style=\"margin: 10px 0;\">ابقَ على اطّلاع دائم بالفعاليات الجديدة والتنبيهات المهمة عبر تيليغرام:</p>
              <ol style=\"margin: 10px 0; padding-left: 20px;\">
                <li><strong>حمّل تطبيق تيليغرام</strong> وأنشئ حسابًا</li>
                <li><strong>ابحث عن: "nahkyaraby_bot@"</strong> ثم اضغط "Start"</li>
                <li><strong>تواصل مع المشرف</strong> لتأكيد اكتمال الإعداد</li>
              </ol>
              <p style=\"margin: 10px 0 0 0; font-size: 14px; color: #6B7280;\">ملاحظة: إعداد تيليغرام اختياري ولكنه موصى به بشدة للحصول على إشعارات فورية حول الفعاليات والتحديثات.</p>
            </div>
            
            <p>لأي استفسار، يرجى التواصل مع المشرف.</p>
          </div>
          
          <div class="divider"></div>
          
          <div class="content">
            <h2>Welcome to Our Platform!</h2>
            <h3>Hello ${name},</h3>
            <p>You've been invited to join Nahky Araby Event Hub. This app will help you manage your event participation and track your progress.</p>
            
            <div class="credentials">
              <h3 style="margin-top: 0; color: #10B981;">🔐 Your Login Credentials</h3>
              <div class="credential-row">
                <div class="credential-label">Username (Email)</div>
                <div class="credential-value">${email}</div>
              </div>
              <div class="credential-row">
                <div class="credential-label">Temporary Password</div>
                <div class="credential-value">${tempPassword}</div>
              </div>
            </div>
            
            <div class="warning-box">
              <strong>⚠️ Important - First Login</strong>
              <p style="margin: 10px 0 0 0;">When you first log in with these credentials, you will be required to set up a new secure password before accessing your account.</p>
            </div>
            
            <div class="info-box">
              <h3 style="margin-top: 0;">📋 Next Steps</h3>
              <ol style="margin: 10px 0; padding-left: 20px;">
                <li>Visit Nahky Araby Event Hub login page</li>
                <li>Enter your email and temporary password</li>
                <li>Create a new secure password</li>
                <li>Start managing your events and tracking your progress!</li>
              </ol>
            </div>
            
            <div class="info-box" style="background-color: #DBEAFE;">
              <h3 style=\\\"margin-top: 0;\\\">✈️ Setting Up Telegram Notifications</h3>
              <p style=\\\"margin: 10px 0;\\\">Stay updated on new events and important notifications via Telegram:</p>
              <ol style=\\\"margin: 10px 0; padding-right: 20px;\\\">
                <li><strong>Download Telegram</strong> and sign up for an account</li>
                <li><strong>Search for "@nahkyaraby_bot"</strong> and click the "Start" button</li>
                <li><strong>Contact the admin</strong> and confirm that the setup is completed</li>
              </ol>
              <p style=\\\"margin: 10px 0 0 0; font-size: 14px; color: #6B7280;\\\">Note: Setting up Telegram is optional but highly recommended to receive real-time notifications about new events and updates.</p>
            </div>
            
            <p>If you have any questions, please contact your administrator.</p>
          </div>
          <div class="footer">
            <p>هذه رسالة آلية — يرجى عدم الرد على هذا البريد.<br>This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const emailResult = await sendEmail(
      email,
      'Welcome to Nahky Araby Event Hub - Your Invitation',
      emailHtml
    );

    if (!emailResult.success) {
      // User is created successfully, just email failed
      // This is expected in Resend testing mode
      console.log('✅ Staff member created:', staffMember.name, '- Manual credentials provided (email in testing mode)');
      
      return c.json({ 
        success: true, 
        staff: staffMember,
        tempPassword,
        emailSent: false,
        isTestingMode: emailResult.isTestingMode || false
      });
    }

    return c.json({ 
      success: true, 
      staff: staffMember,
      tempPassword,
      emailSent: true
    });
  } catch (error) {
    console.error('Error inviting staff:', error);
    return c.json({ error: 'Failed to invite staff member' }, 500);
  }
});

// Update staff member (admin only)
app.put("/make-server-08658f87/staff/:id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const staffId = c.req.param('id');
    const { name, email, phone, level, telegramUsername } = await c.req.json();

    // Get existing staff member
    const staff = await kv.get(`user:${staffId}`);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Update staff member
    const updatedStaff = {
      ...staff,
      name,
      email,
      phone: phone || '',
      level,
      telegramChatId: telegramUsername || '',  // Store as telegramChatId (Telegram Chat IDs are numeric strings)
      telegramUsername: telegramUsername || ''  // Keep for backwards compatibility
    };

    await kv.set(`user:${staffId}`, updatedStaff);

    return c.json({ 
      success: true, 
      staff: updatedStaff
    });
  } catch (error) {
    console.error('Error updating staff:', error);
    return c.json({ error: 'Failed to update staff member' }, 500);
  }
});

// Delete staff member (admin only)
app.delete("/make-server-08658f87/staff/:id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const staffId = c.req.param('id');

    // Get staff member to verify they exist
    const staff = await kv.get(`user:${staffId}`);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Prevent deleting admin users
    if (staff.role === 'admin') {
      return c.json({ error: 'Cannot delete admin users' }, 403);
    }

    // Remove staff from all events they're signed up for
    const events = await kv.getByPrefix('event:');
    for (const event of events) {
      if (event.signedUpStaff && event.signedUpStaff.includes(staffId)) {
        const updatedEvent = {
          ...event,
          signedUpStaff: event.signedUpStaff.filter((id: string) => id !== staffId)
        };
        await kv.set(`event:${event.id}`, updatedEvent);
      }
    }

    // Delete staff member from KV store
    await kv.del(`user:${staffId}`);

    // Delete user from Supabase Auth
    const supabase = getSupabaseAdmin();
    const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(staffId);
    
    if (deleteAuthError) {
      console.error('Error deleting user from Auth:', deleteAuthError);
      // Continue anyway - user is already deleted from KV store
    }

    return c.json({ success: true, message: 'Staff member deleted successfully' });
  } catch (error) {
    console.error('Error deleting staff member:', error);
    return c.json({ error: 'Failed to delete staff member' }, 500);
  }
});

// Send password reset for staff member (admin only)
app.post("/make-server-08658f87/staff/password-reset", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { staffId } = await c.req.json();

    // Get staff member
    const staff = await kv.get(`user:${staffId}`);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Generate temporary password
    const tempPassword = `reset${Math.random().toString(36).slice(2, 10)}`;

    const supabase = getSupabaseAdmin();

    // Update the user's password in Supabase Auth
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      staffId,
      { password: tempPassword }
    );

    if (updateError) {
      console.error('Error updating staff password:', updateError);
      return c.json({ error: 'Failed to generate temporary password' }, 500);
    }

    // Send password reset email with temporary password
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .credentials { background-color: white; padding: 25px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #F59E0B; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
          .credential-row { margin: 15px 0; }
          .credential-label { color: #6B7280; font-size: 14px; margin-bottom: 5px; }
          .credential-value { background-color: #F3F4F6; padding: 10px 15px; border-radius: 6px; font-family: monospace; font-size: 16px; color: #1F2937; border: 1px solid #E5E7EB; }
          .footer { text-align: center; margin-top: 20px; color: #666; font-size: 14px; }
          .warning-box { background-color: #FEF3C7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #F59E0B; }
          .info-box { background-color: #EFF6FF; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3B82F6; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div style="text-align: center; margin-bottom: 10px;">
              <img src="https://img1.wsimg.com/isteam/ip/aead55c7-5dc3-4ad4-8132-6139ccf3e033/nahky.png/:/rs=w:132,h:104,cg:true,m/cr=w:132,h:104/qt=q:95" alt="Nahky Araby Logo" style="max-width: 200px; height: auto;" />
            </div>
            <h2 style="margin: 10px 0 20px 0; font-size: 24px; font-weight: 600; opacity: 1;">Nahky Araby Event Hub</h2>
            <h1>Password Reset</h1>
          </div>
          <div class="content">
            <h2>Hello ${staff.name},</h2>
            <p>Your password has been reset by an administrator. Below are your new temporary login credentials.</p>
            
            <div class="credentials">
              <h3 style="margin-top: 0; color: #F59E0B;">🔐 Your New Login Credentials</h3>
              <div class="credential-row">
                <div class="credential-label">Username (Email)</div>
                <div class="credential-value">${staff.email}</div>
              </div>
              <div class="credential-row">
                <div class="credential-label">Temporary Password</div>
                <div class="credential-value">${tempPassword}</div>
              </div>
            </div>
            
            <div class="warning-box">
              <strong>⚠️ Important - First Login</strong>
              <p style="margin: 10px 0 0 0;">When you log in with this temporary password, you will be required to set up a new secure password before accessing your account.</p>
            </div>
            
            <div class="info-box">
              <h3 style="margin-top: 0;">📋 Next Steps</h3>
              <ol style="margin: 10px 0; padding-left: 20px;">
                <li>Visit Nahky Araby Event Hub login page</li>
                <li>Enter your email and temporary password</li>
                <li>Create a new secure password</li>
                <li>Continue managing your events!</li>
              </ol>
            </div>
            
            <p>If you didn't request this password reset, please contact your administrator immediately.</p>
          </div>
          <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const emailResult = await sendEmail(
      staff.email,
      'Password Reset - Nahky Araby Event Hub',
      emailHtml
    );

    if (!emailResult.success) {
      // Password reset successful, just email failed
      // This is expected in Resend testing mode
      console.log('🔑 Temporary password generated for:', staff.name, '- Manual credentials provided (email in testing mode)');
      
      return c.json({ 
        success: true,
        message: `Temporary password generated for ${staff.name}`,
        emailSent: false,
        isTestingMode: emailResult.isTestingMode || false,
        tempPassword: tempPassword,
        staff: {
          id: staff.id,
          email: staff.email,
          name: staff.name
        }
      });
    }

    return c.json({ 
      success: true,
      message: `Password reset email sent to ${staff.email}`,
      emailSent: true
    });
  } catch (error) {
    console.error('Error sending password reset:', error);
    return c.json({ error: 'Failed to send password reset' }, 500);
  }
});

// Password setup endpoint for new staff members
app.post("/make-server-08658f87/staff/setup-password", async (c) => {
  try {
    const { email, tempPassword, newPassword } = await c.req.json();

    if (!email || !tempPassword || !newPassword) {
      return c.json({ error: 'Email, temporary password, and new password are required' }, 400);
    }

    const supabase = getSupabaseClient();

    // First, sign in with the temporary password
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: tempPassword,
    });

    if (signInError || !signInData.session) {
      console.error('Error signing in with temp password:', signInError);
      return c.json({ error: 'Invalid temporary credentials' }, 401);
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Update the password using admin client
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      signInData.user.id,
      { password: newPassword }
    );

    if (updateError) {
      console.error('Error updating password:', updateError);
      return c.json({ error: 'Failed to update password' }, 500);
    }

    // Update staff status to active
    const staffMember = await kv.get(`user:${signInData.user.id}`);
    if (staffMember) {
      staffMember.status = 'active';
      await kv.set(`user:${signInData.user.id}`, staffMember);
    }

    // Sign in again with the new password to get a fresh session
    // (updating password invalidates existing sessions)
    const { data: newSignInData, error: newSignInError } = await supabase.auth.signInWithPassword({
      email,
      password: newPassword,
    });

    if (newSignInError || !newSignInData.session) {
      console.error('Error signing in with new password:', newSignInError);
      // Password was updated but sign-in failed - user can still login manually
      return c.json({ 
        error: 'Password updated but automatic sign-in failed. Please log in with your new password.' 
      }, 500);
    }

    // Calculate level based on points if no staff member found
    const defaultLevel = await calculateLevel(0);
    
    return c.json({ 
      success: true,
      message: 'Password updated successfully',
      accessToken: newSignInData.session.access_token,
      user: staffMember || {
        id: newSignInData.user.id,
        email: newSignInData.user.email,
        name: newSignInData.user.user_metadata.name,
        role: 'staff',
        points: 0,
        level: defaultLevel
      }
    });
  } catch (error) {
    console.error('Error setting up password:', error);
    return c.json({ error: 'Failed to set up password' }, 500);
  }
});

// ==================== ADMIN SETTINGS ENDPOINTS ====================

// Get admin settings
app.get("/make-server-08658f87/admin/settings", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const settings = await kv.get('admin:settings') || { email: '', phone: '' };
    return c.json(settings);
  } catch (error) {
    console.error('Error fetching admin settings:', error);
    return c.json({ error: 'Failed to fetch admin settings' }, 500);
  }
});

// Save admin settings
app.post("/make-server-08658f87/admin/settings", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { email, phone } = await c.req.json();

    const settings = { email, phone };
    await kv.set('admin:settings', settings);

    return c.json({ success: true });
  } catch (error) {
    console.error('Error saving admin settings:', error);
    return c.json({ error: 'Failed to save admin settings' }, 500);
  }
});

// ==================== WHATSAPP ENDPOINTS ====================

// Helper function to send WhatsApp message
const sendWhatsAppMessage = async (to: string, message: string) => {
  const whatsAppSettings = await kv.get('whatsapp:settings');
  
  if (!whatsAppSettings || !whatsAppSettings.phoneNumberId || !whatsAppSettings.accessToken) {
    console.error('WhatsApp not configured');
    return { success: false, error: 'WhatsApp not configured' };
  }

  const { phoneNumberId, accessToken } = whatsAppSettings;

  // Remove any formatting from phone number (spaces, dashes, etc)
  const cleanPhone = to.replace(/[^\d+]/g, '');
  
  // Ensure phone has country code
  if (!cleanPhone.startsWith('+')) {
    console.error('Phone number must include country code:', to);
    return { success: false, error: 'Phone number must include country code (e.g., +1234567890)' };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          type: 'text',
          text: { body: message },
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error('WhatsApp API error:', result);
      return { success: false, error: result.error?.message || 'Failed to send WhatsApp message' };
    }

    console.log('WhatsApp message sent successfully:', result.messages?.[0]?.id);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    return { success: false, error: error.message };
  }
};

// Connect WhatsApp Business account
app.post("/make-server-08658f87/whatsapp/connect", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { phoneNumberId, accessToken } = await c.req.json();

    if (!phoneNumberId || !accessToken) {
      return c.json({ error: 'Phone Number ID and Access Token are required' }, 400);
    }

    // Verify the credentials by making a test API call
    try {
      const testResponse = await fetch(
        `https://graph.facebook.com/v18.0/${phoneNumberId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );

      if (!testResponse.ok) {
        const errorData = await testResponse.json();
        console.error('WhatsApp verification failed:', errorData);
        return c.json({ 
          error: 'Invalid WhatsApp credentials. Please check your Phone Number ID and Access Token.' 
        }, 400);
      }

      const phoneData = await testResponse.json();
      const displayPhoneNumber = phoneData.display_phone_number || phoneData.verified_name || '';

      // Save WhatsApp settings
      const whatsAppSettings = {
        phoneNumberId,
        accessToken,
        phoneNumber: displayPhoneNumber,
        connected: true,
        connectedAt: new Date().toISOString(),
      };

      await kv.set('whatsapp:settings', whatsAppSettings);

      return c.json({ 
        success: true, 
        phoneNumber: displayPhoneNumber 
      });
    } catch (verifyError) {
      console.error('Error verifying WhatsApp credentials:', verifyError);
      return c.json({ 
        error: 'Failed to verify WhatsApp credentials. Please check your settings.' 
      }, 400);
    }
  } catch (error) {
    console.error('Error connecting WhatsApp:', error);
    return c.json({ error: 'Failed to connect WhatsApp' }, 500);
  }
});

// Get WhatsApp connection status
app.get("/make-server-08658f87/whatsapp/status", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    try {
      const whatsAppSettings = await kv.get('whatsapp:settings');

      if (!whatsAppSettings || !whatsAppSettings.connected) {
        return c.json({ connected: false });
      }

      return c.json({ 
        connected: true,
        phoneNumber: whatsAppSettings.phoneNumber || ''
      });
    } catch (kvError) {
      console.error('Error accessing WhatsApp settings from KV:', kvError);
      return c.json({ connected: false });
    }
  } catch (error) {
    console.error('Error checking WhatsApp status:', error);
    return c.json({ connected: false }, 500);
  }
});

// Helper function to send Telegram message
const sendTelegramMessage = async (chatId: string, message: string) => {
  // Validate that chatId is numeric
  if (!/^\d+$/.test(chatId)) {
    const isUsername = chatId.startsWith('@') || /^[a-zA-Z]/.test(chatId);
    console.error('Invalid Chat ID format:', chatId);
    return { 
      success: false, 
      error: isUsername 
        ? `Invalid Chat ID: "${chatId}" is a username. You must use the numeric Chat ID (e.g., 123456789). Click "Fetch from Bot" to get the correct ID.`
        : `Invalid Chat ID format: "${chatId}". Chat ID must be numeric only.`
    };
  }

  const telegramSettings = await kv.get('telegram:settings');
  
  if (!telegramSettings || !telegramSettings.botToken) {
    console.error('Telegram not configured');
    return { success: false, error: 'Telegram not configured' };
  }

  const { botToken } = telegramSettings;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown',
        }),
      }
    );

    const result = await response.json();

    if (!result.ok) {
      console.error('Telegram API error for Chat ID:', chatId, 'Error:', result);
      const errorDesc = result.description || 'Failed to send Telegram message';
      
      // Provide more helpful error messages
      if (errorDesc.toLowerCase().includes('chat not found')) {
        return { 
          success: false, 
          error: `Chat not found for ID: ${chatId}. The user must start a conversation with your bot first.` 
        };
      } else if (errorDesc.toLowerCase().includes('bot was blocked')) {
        return { 
          success: false, 
          error: `User has blocked the bot. Ask them to unblock it in Telegram.` 
        };
      } else if (errorDesc.toLowerCase().includes('user is deactivated')) {
        return { 
          success: false, 
          error: `This Telegram account is deactivated.` 
        };
      }
      
      return { success: false, error: errorDesc };
    }

    console.log('Telegram message sent successfully to Chat ID:', chatId, 'Message ID:', result.result.message_id);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error sending Telegram message to Chat ID:', chatId, 'Error:', error);
    return { success: false, error: error.message };
  }
};

// Connect Telegram Bot
app.post("/make-server-08658f87/telegram/connect", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { botToken } = await c.req.json();

    if (!botToken) {
      return c.json({ error: 'Bot Token is required' }, 400);
    }

    // Verify the bot token by making a test API call
    try {
      const testResponse = await fetch(
        `https://api.telegram.org/bot${botToken}/getMe`,
        {
          method: 'GET',
        }
      );

      const botData = await testResponse.json();

      if (!botData.ok) {
        console.error('Telegram verification failed:', botData);
        return c.json({ 
          error: 'Invalid Telegram bot token. Please check your token.' 
        }, 400);
      }

      const botName = botData.result.username || botData.result.first_name || '';

      // Save Telegram settings
      const telegramSettings = {
        botToken,
        botName,
        connected: true,
        connectedAt: new Date().toISOString(),
      };

      await kv.set('telegram:settings', telegramSettings);

      return c.json({ 
        success: true, 
        botName 
      });
    } catch (verifyError) {
      console.error('Error verifying Telegram bot token:', verifyError);
      return c.json({ 
        error: 'Failed to verify Telegram bot token. Please check your settings.' 
      }, 400);
    }
  } catch (error) {
    console.error('Error connecting Telegram:', error);
    return c.json({ error: 'Failed to connect Telegram' }, 500);
  }
});

// Get Telegram connection status
app.get("/make-server-08658f87/telegram/status", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    try {
      const telegramSettings = await kv.get('telegram:settings');

      if (!telegramSettings || !telegramSettings.connected) {
        return c.json({ connected: false });
      }

      return c.json({ 
        connected: true,
        botName: telegramSettings.botName || ''
      });
    } catch (kvError) {
      console.error('Error accessing Telegram settings from KV:', kvError);
      return c.json({ connected: false });
    }
  } catch (error) {
    console.error('Error checking Telegram status:', error);
    return c.json({ connected: false }, 500);
  }
});

// Send Telegram test message to a staff member
app.post("/make-server-08658f87/telegram/test", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { staffId } = await c.req.json();

    if (!staffId) {
      return c.json({ error: 'Staff ID is required' }, 400);
    }

    // Get staff member
    const staff = await kv.get(`user:${staffId}`);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Check if staff has Telegram chat ID
    if (!staff.telegramUsername) {
      return c.json({ error: 'Staff member does not have a Telegram Chat ID configured' }, 400);
    }

    // Send test message
    const message = `🎉 *Test Message*\n\nHello ${staff.name}!\n\nThis is a test message from the Staff Management App. Your Telegram account is successfully connected! 📱\n\n_You will receive event notifications on this account._`;
    
    const result = await sendTelegramMessage(staff.telegramUsername, message);

    if (!result.success) {
      // Check if it's a chat not found error
      const errorMsg = result.error || 'Failed to send test message';
      if (errorMsg.includes('chat not found')) {
        return c.json({ 
          error: 'Chat not found. Please verify the Chat ID is correct. The staff member must first start a conversation with your Telegram bot, then get their Chat ID from @userinfobot.' 
        }, 400);
      }
      return c.json({ error: errorMsg }, 500);
    }

    return c.json({ 
      success: true, 
      message: 'Test message sent successfully to ' + staff.name
    });
  } catch (error) {
    console.error('Error sending Telegram test message:', error);
    return c.json({ error: 'Failed to send test message' }, 500);
  }
});

// Test a specific Chat ID
app.post("/make-server-08658f87/telegram/test-chat-id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { chatId, name } = await c.req.json();

    if (!chatId) {
      return c.json({ error: 'Chat ID is required' }, 400);
    }

    // Send test message
    const message = `🎉 *Test Message*\\n\\nHello ${name || 'there'}!\\n\\nThis is a test message from the Staff Management App. Your Telegram account is successfully connected! 📱\\n\\n_You will receive event notifications on this account._`;
    
    const result = await sendTelegramMessage(chatId, message);

    if (!result.success) {
      return c.json({ error: result.error || 'Failed to send test message' }, 400);
    }

    return c.json({ 
      success: true, 
      message: `Test message sent successfully to Chat ID: ${chatId}`
    });
  } catch (error) {
    console.error('Error testing Chat ID:', error);
    return c.json({ error: 'Failed to send test message' }, 500);
  }
});

// Clear old Telegram updates
app.post("/make-server-08658f87/telegram/clear-updates", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    // Get Telegram settings
    const telegramSettings = await kv.get('telegram:settings');
    
    if (!telegramSettings || !telegramSettings.botToken) {
      return c.json({ error: 'Telegram not configured' }, 400);
    }

    const { botToken } = telegramSettings;

    // First, get all updates
    const getResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?limit=100`,
      { method: 'GET' }
    );

    const getResult = await getResponse.json();

    if (getResult.ok && getResult.result && getResult.result.length > 0) {
      // Get the highest update_id
      const lastUpdateId = getResult.result[getResult.result.length - 1].update_id;
      
      // Clear all updates by setting offset to last update_id + 1
      await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}`,
        { method: 'GET' }
      );
      
      console.log(`Cleared ${getResult.result.length} old Telegram updates`);
      
      return c.json({ 
        success: true, 
        message: `Cleared ${getResult.result.length} old updates. New messages will appear on next fetch.`
      });
    }

    return c.json({ 
      success: true, 
      message: 'No updates to clear'
    });
  } catch (error) {
    console.error('Error clearing Telegram updates:', error);
    return c.json({ error: 'Failed to clear updates' }, 500);
  }
});

// Get recent Telegram chat IDs from bot updates
app.post("/make-server-08658f87/telegram/get-recent-chats", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    // Get Telegram settings
    const telegramSettings = await kv.get('telegram:settings');
    
    if (!telegramSettings || !telegramSettings.botToken) {
      return c.json({ error: 'Telegram not configured' }, 400);
    }

    const { botToken } = telegramSettings;

    // Fetch recent updates from Telegram
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?limit=100`,
      {
        method: 'GET',
      }
    );

    const result = await response.json();

    if (!result.ok) {
      console.error('Telegram API error:', result);
      return c.json({ error: result.description || 'Failed to fetch updates' }, 500);
    }

    // Extract unique chat IDs and user information
    const chats = new Map();
    
    if (result.result && Array.isArray(result.result)) {
      for (const update of result.result) {
        if (update.message && update.message.from) {
          const chatId = update.message.chat.id.toString();
          const from = update.message.from;
          
          if (!chats.has(chatId)) {
            chats.set(chatId, {
              chatId,
              firstName: from.first_name || '',
              lastName: from.last_name || '',
              username: from.username ? `@${from.username}` : '',
              lastMessage: update.message.text || '(media)',
              timestamp: update.message.date * 1000, // Convert to milliseconds
            });
          }
        }
      }
    }

    // Convert to array and sort by most recent
    const chatList = Array.from(chats.values()).sort((a, b) => b.timestamp - a.timestamp);

    console.log(`Found ${chatList.length} recent Telegram chats:`, chatList.map(c => ({ 
      chatId: c.chatId, 
      name: `${c.firstName} ${c.lastName}`.trim() 
    })));

    return c.json({ 
      success: true, 
      chats: chatList,
      count: chatList.length
    });
  } catch (error) {
    console.error('Error fetching Telegram updates:', error);
    return c.json({ error: 'Failed to fetch recent chats' }, 500);
  }
});

// Debug endpoint to check notification eligibility
app.get("/make-server-08658f87/debug/notifications", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    // Get all users
    const allUsers = await kv.getByPrefix('user:');
    
    console.log('=== DEBUG ENDPOINT DETAILED ANALYSIS ===');
    console.log(`Total users in database: ${allUsers.length}`);
    console.log('All users:', allUsers.map(u => ({ 
      name: u.name, 
      email: u.email, 
      role: u.role, 
      status: u.status 
    })));
    
    const staffMembers = allUsers.filter(u => u.role === 'staff' || !u.role);
    console.log(`After staff filter (role === 'staff' || !role): ${staffMembers.length} users`);
    console.log('Staff members:', staffMembers.map(u => ({ 
      name: u.name, 
      email: u.email, 
      role: u.role, 
      status: u.status 
    })));
    
    const activeStaff = staffMembers.filter(u => u.status === 'active');
    
    // Get telegram settings
    const telegramSettings = await kv.get('telegram:settings');
    
    // Get levels
    const levels = await kv.getByPrefix('level:');
    const sortedLevels = levels.sort((a, b) => a.order - b.order);
    
    // Check only staff members (deduplicate by email first, exclude admins)
    const uniqueStaffMap = new Map();
    staffMembers.forEach(staff => {
      console.log(`Processing user: ${staff.name}, role: ${staff.role}, is admin: ${staff.role === 'admin'}`);
      // Exclude admins from the debug display
      if (staff.role !== 'admin' && !uniqueStaffMap.has(staff.email)) {
        uniqueStaffMap.set(staff.email, staff);
        console.log(`  -> Added to display: ${staff.name}`);
      } else if (staff.role === 'admin') {
        console.log(`  -> Excluded (admin): ${staff.name}`);
      } else {
        console.log(`  -> Excluded (duplicate email): ${staff.name}`);
      }
    });
    const uniqueStaff = Array.from(uniqueStaffMap.values());
    
    console.log(`Final unique staff count for display: ${uniqueStaff.length}`);
    console.log(`Staff details:`, uniqueStaff.map(s => ({ name: s.name, email: s.email, role: s.role, status: s.status, level: s.level, telegramChatId: (s.telegramChatId || s.telegramUsername) ? 'SET' : 'NOT SET' })));
    console.log('=== END DEBUG ANALYSIS ===');
    
    const staffStatus = uniqueStaff.map(staff => {
      const issues = [];
      
      // Check eligibility for notifications (check both fields for backwards compatibility)
      const chatId = staff.telegramChatId || staff.telegramUsername;
      if (staff.status !== 'active') issues.push('Status is not active (status: ' + staff.status + ')');
      if (!staff.level) issues.push('No level assigned');
      if (!chatId || chatId.trim() === '') issues.push('No Telegram Chat ID');
      
      const staffLevel = sortedLevels.find(l => l.name === staff.level);
      
      return {
        name: staff.name,
        email: staff.email,
        role: staff.role || 'staff',
        status: staff.status || 'unknown',
        level: staff.level || 'NONE',
        levelOrder: staffLevel?.order ?? 'N/A',
        telegramChatId: chatId || 'NOT SET',
        eligible: issues.length === 0,
        issues: issues
      };
    });
    
    return c.json({
      summary: {
        totalUsers: allUsers.length,
        staffMembers: staffMembers.length,
        activeStaff: activeStaff.length,
        telegramConnected: telegramSettings?.connected || false,
        telegramBotName: telegramSettings?.botName || 'NOT SET',
        levelsConfigured: levels.length
      },
      levels: sortedLevels.map(l => ({ name: l.name, minPoints: l.minPoints, order: l.order })),
      staffStatus: staffStatus,
      debugInfo: {
        allUsersSnapshot: allUsers.map(u => ({ name: u.name, email: u.email, role: u.role, status: u.status })),
        staffMembersSnapshot: staffMembers.map(u => ({ name: u.name, email: u.email, role: u.role, status: u.status })),
        uniqueStaffSnapshot: uniqueStaff.map(u => ({ name: u.name, email: u.email, role: u.role, status: u.status }))
      }
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return c.json({ error: 'Failed to generate debug info' }, 500);
  }
});

// ==================== LEVELS ENDPOINTS ====================

// Get all levels
app.get("/make-server-08658f87/levels", async (c) => {
  try {
    // Don't require auth for levels - they're needed during login
    const levels = await kv.getByPrefix('level:');
    return c.json({ levels });
  } catch (error) {
    console.error('Error fetching levels:', error);
    return c.json({ error: 'Failed to fetch levels' }, 500);
  }
});

// Add new level (admin only)
app.post("/make-server-08658f87/levels", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { name, minPoints } = await c.req.json();

    if (!name || minPoints === undefined) {
      return c.json({ error: 'Name and minPoints are required' }, 400);
    }

    const levelId = `${Date.now()}`;
    const levels = await kv.getByPrefix('level:');
    
    const level = {
      id: levelId,
      name,
      minPoints,
      order: levels.length,
      createdAt: new Date().toISOString()
    };

    await kv.set(`level:${levelId}`, level);

    return c.json({ success: true, level });
  } catch (error) {
    console.error('Error adding level:', error);
    return c.json({ error: 'Failed to add level' }, 500);
  }
});

// Update level (admin only)
app.put("/make-server-08658f87/levels/:id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const levelId = c.req.param('id');
    const { name, minPoints } = await c.req.json();

    const existingLevel = await kv.get(`level:${levelId}`);
    if (!existingLevel) {
      return c.json({ error: 'Level not found' }, 404);
    }

    const updatedLevel = {
      ...existingLevel,
      name,
      minPoints
    };

    await kv.set(`level:${levelId}`, updatedLevel);

    return c.json({ success: true, level: updatedLevel });
  } catch (error) {
    console.error('Error updating level:', error);
    return c.json({ error: 'Failed to update level' }, 500);
  }
});

// Delete level (admin only)
app.delete("/make-server-08658f87/levels/:id", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const levelId = c.req.param('id');
    await kv.del(`level:${levelId}`);

    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting level:', error);
    return c.json({ error: 'Failed to delete level' }, 500);
  }
});

// Reorder levels (admin only)
app.post("/make-server-08658f87/levels/reorder", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { levelId, direction } = await c.req.json();
    
    if (!levelId || !direction || (direction !== 'up' && direction !== 'down')) {
      return c.json({ error: 'Valid levelId and direction (up/down) are required' }, 400);
    }

    const levels = await kv.getByPrefix('level:');
    const sortedLevels = levels.sort((a: any, b: any) => a.order - b.order);
    
    const currentIndex = sortedLevels.findIndex((l: any) => l.id === levelId);
    if (currentIndex === -1) {
      return c.json({ error: 'Level not found' }, 404);
    }

    // Can't move first item up or last item down
    if ((direction === 'up' && currentIndex === 0) || 
        (direction === 'down' && currentIndex === sortedLevels.length - 1)) {
      return c.json({ error: 'Cannot move level in that direction' }, 400);
    }

    // Swap orders
    const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const temp = sortedLevels[currentIndex].order;
    sortedLevels[currentIndex].order = sortedLevels[swapIndex].order;
    sortedLevels[swapIndex].order = temp;

    // Update both levels in KV store
    await kv.set(`level:${sortedLevels[currentIndex].id}`, sortedLevels[currentIndex]);
    await kv.set(`level:${sortedLevels[swapIndex].id}`, sortedLevels[swapIndex]);

    // Return updated levels
    const updatedLevels = await kv.getByPrefix('level:');
    return c.json({ success: true, levels: updatedLevels });
  } catch (error) {
    console.error('Error reordering levels:', error);
    return c.json({ error: 'Failed to reorder levels' }, 500);
  }
});

// ==================== POINT ADJUSTMENT ENDPOINTS ====================

// Adjust staff points (admin only)
app.post("/make-server-08658f87/points/adjust", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { staffId, points, reason } = await c.req.json();

    if (!staffId || points === undefined || !reason) {
      return c.json({ error: 'Staff ID, points, and reason are required' }, 400);
    }

    // Get staff member
    const staff = await kv.get(`user:${staffId}`);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Calculate new points and level
    const oldLevel = staff.level;
    const newPoints = Math.max(0, staff.points + points);
    const newLevel = await calculateLevel(newPoints);

    // Update staff member
    const updatedStaff = {
      ...staff,
      points: newPoints,
      level: newLevel
    };

    await kv.set(`user:${staffId}`, updatedStaff);

    // Record adjustment
    const adjustmentId = `${Date.now()}`;
    const adjustment = {
      id: adjustmentId,
      staffId,
      points,
      reason,
      timestamp: new Date().toISOString(),
      adminId: user.id
    };

    await kv.set(`adjustment:${adjustmentId}`, adjustment);

    // Send email notification to staff member
    const pointsChange = points > 0 ? 'added' : 'subtracted';
    const pointsDisplay = Math.abs(points);
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: ${points > 0 ? '#10B981' : '#F59E0B'}; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .points-box { background-color: white; padding: 25px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${points > 0 ? '#10B981' : '#F59E0B'}; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); text-align: center; }
          .points-value { font-size: 48px; font-weight: bold; color: ${points > 0 ? '#10B981' : '#F59E0B'}; margin: 10px 0; }
          .reason-box { background-color: #EFF6FF; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3B82F6; }
          .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #6b7280; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div style="text-align: center; margin-bottom: 10px;">
              <img src="https://img1.wsimg.com/isteam/ip/aead55c7-5dc3-4ad4-8132-6139ccf3e033/nahky.png/:/rs=w:132,h:104,cg:true,m/cr=w:132,h:104/qt=q:95" alt="Nahky Araby Logo" style="max-width: 200px; height: auto;" />
            </div>
            <h2 style="margin: 10px 0 20px 0; font-size: 24px; font-weight: 600; opacity: 1;">Nahky Araby Event Hub</h2>
            <h1>${points > 0 ? '🎉' : '📊'} Points ${points > 0 ? 'Added' : 'Adjusted'}</h1>
          </div>
          <div class="content">
            <p>Hello ${staff.name},</p>
            
            <p>${points > 0 ? 'Great news!' : 'Your points have been adjusted.'} Your account has been ${pointsChange} with the following:</p>
            
            <div class="points-box">
              <div style="font-size: 16px; color: #6B7280; margin-bottom: 5px;">Points ${points > 0 ? 'Added' : 'Subtracted'}</div>
              <div class="points-value">${points > 0 ? '+' : ''}${points}</div>
              <div style="font-size: 14px; color: #6B7280; margin-top: 10px;">New Total: ${newPoints} points</div>
              ${oldLevel !== newLevel ? `<div style="font-size: 16px; color: #10B981; margin-top: 15px; font-weight: bold;">🎊 Level Up! You are now ${newLevel}!</div>` : ''}
            </div>
            
            <div class="reason-box">
              <h3 style="margin-top: 0; color: #3B82F6;">📝 Reason</h3>
              <p style="margin: 5px 0;">${reason}</p>
            </div>
            
            <p>You can view your current points and level by logging into Nahky Araby Event Hub.</p>
            
            <p style="margin-top: 30px;">Keep up the great work!</p>
          </div>
          <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const emailResult = await sendEmail(
        staff.email,
        `Points ${points > 0 ? 'Added' : 'Adjusted'}: ${pointsDisplay} points`,
        emailHtml
      );
      
      if (emailResult.success) {
        console.log(`✅ Points adjustment email sent successfully`);
        console.log(`   📧 To: ${staff.name} (${staff.email})`);
        console.log(`   📝 Subject: Points ${points > 0 ? 'Added' : 'Adjusted'}: ${pointsDisplay} points`);
      } else {
        console.log(`⚠️ Points adjustment email failed`);
        console.log(`   📧 Intended for: ${staff.name} (${staff.email})`);
        console.log(`   ❌ Error: ${emailResult.error}`);
        if (emailResult.isTestingMode) {
          console.log(`   ℹ️ NOTE: In Resend test mode, check delivered@resend.dev for this email`);
        }
      }
    } catch (emailError) {
      console.error('❌ Error sending points adjustment email:', emailError);
    }

    return c.json({ 
      success: true, 
      staff: updatedStaff,
      adjustment,
      leveledUp: oldLevel !== newLevel
    });
  } catch (error) {
    console.error('Error adjusting points:', error);
    return c.json({ error: 'Failed to adjust points' }, 500);
  }
});

// Get point adjustments
app.get("/make-server-08658f87/adjustments", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const adjustments = await kv.getByPrefix('adjustment:');
    
    // Convert adjustments to transaction format
    const transactions = await Promise.all(adjustments.map(async (adj) => {
      const staff = await kv.get(`user:${adj.staffId}`);
      return {
        id: adj.id,
        staffId: adj.staffId,
        staffName: staff?.name || 'Unknown Staff',
        points: adj.points,
        reason: adj.reason,
        timestamp: adj.timestamp,
        adminId: adj.adminId,
        eventId: adj.eventId,
      };
    }));
    
    return c.json({ adjustments, transactions });
  } catch (error) {
    console.error('Error fetching adjustments:', error);
    return c.json({ error: 'Failed to fetch adjustments' }, 500);
  }
});

// ==================== EVENT SIGNUP ENDPOINTS ====================

// Sign up for event
app.post("/make-server-08658f87/signups", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    const { eventId } = await c.req.json();

    if (!eventId) {
      return c.json({ error: 'Event ID is required' }, 400);
    }

    // Get event
    const event = await kv.get(`event:${eventId}`);
    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Check if already signed up
    if (event.signedUpStaff && event.signedUpStaff.includes(user.id)) {
      return c.json({ error: 'Already signed up for this event' }, 400);
    }

    // Check if event is in the past
    const eventDate = new Date(`${event.date}T${event.time}`);
    if (eventDate < new Date()) {
      return c.json({ error: 'Cannot sign up for past events' }, 400);
    }

    // Add user to signups with timestamp
    const signUpTimestamp = new Date().toISOString();
    const updatedEvent = {
      ...event,
      signedUpStaff: [...(event.signedUpStaff || []), user.id],
      signUpTimestamps: {
        ...(event.signUpTimestamps || {}),
        [user.id]: signUpTimestamp
      }
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    return c.json({ success: true, event: updatedEvent });
  } catch (error) {
    console.error('Error signing up for event:', error);
    return c.json({ error: 'Failed to sign up for event' }, 500);
  }
});

// Cancel event signup
app.delete("/make-server-08658f87/signups/:eventId", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    const eventId = c.req.param('eventId');

    // Get event
    const event = await kv.get(`event:${eventId}`);
    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Remove user from signups and timestamps
    const signUpTimestamps = { ...(event.signUpTimestamps || {}) };
    delete signUpTimestamps[user.id];
    
    const updatedEvent = {
      ...event,
      signedUpStaff: (event.signedUpStaff || []).filter((id: string) => id !== user.id),
      signUpTimestamps
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    return c.json({ success: true, event: updatedEvent });
  } catch (error) {
    console.error('Error cancelling signup:', error);
    return c.json({ error: 'Failed to cancel signup' }, 500);
  }
});

// Admin manually sign up staff for event
app.post("/make-server-08658f87/signups/admin", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { eventId, staffIds } = await c.req.json();

    if (!eventId || !staffIds || !Array.isArray(staffIds)) {
      return c.json({ error: 'Event ID and staff IDs are required' }, 400);
    }

    // Get event
    const event = await kv.get(`event:${eventId}`);
    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Check if event is cancelled
    if (event.status === 'cancelled') {
      return c.json({ error: 'Cannot sign up staff for cancelled events' }, 400);
    }

    // Add staff to signups with timestamp
    const signUpTimestamp = new Date().toISOString();
    const currentSignedUp = event.signedUpStaff || [];
    const currentTimestamps = event.signUpTimestamps || {};
    
    // Filter out staff who are already signed up
    const newStaffIds = staffIds.filter((staffId: string) => !currentSignedUp.includes(staffId));
    
    if (newStaffIds.length === 0) {
      return c.json({ error: 'All selected staff are already signed up' }, 400);
    }

    // Add timestamps for new staff
    const newTimestamps = { ...currentTimestamps };
    newStaffIds.forEach((staffId: string) => {
      newTimestamps[staffId] = signUpTimestamp;
    });

    const updatedEvent = {
      ...event,
      signedUpStaff: [...currentSignedUp, ...newStaffIds],
      signUpTimestamps: newTimestamps
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    return c.json({ success: true, event: updatedEvent, addedCount: newStaffIds.length });
  } catch (error) {
    console.error('Error admin signing up staff for event:', error);
    return c.json({ error: 'Failed to sign up staff for event' }, 500);
  }
});

// Confirm participation and award points (admin only)
app.post("/make-server-08658f87/participation/confirm", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { eventId, staffId } = await c.req.json();

    if (!eventId || !staffId) {
      return c.json({ error: 'Event ID and staff ID are required' }, 400);
    }

    // Get event
    const event = await kv.get(`event:${eventId}`);
    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Get staff member
    const staff = await kv.get(`user:${staffId}`);
    if (!staff) {
      return c.json({ error: 'Staff member not found' }, 404);
    }

    // Check if staff has already received points for this event
    const pointsAwarded = event.pointsAwarded || [];
    if (pointsAwarded.includes(staffId)) {
      return c.json({ error: 'Points already awarded to this staff member' }, 400);
    }

    // Check if staff is in the selected/confirmed list
    const confirmedStaff = event.confirmedStaff || [];
    if (!confirmedStaff.includes(staffId)) {
      return c.json({ error: 'Staff member was not selected for this event' }, 400);
    }

    // Calculate new points and level
    const oldLevel = staff.level;
    const newPoints = staff.points + event.points;
    const newLevel = await calculateLevel(newPoints);

    // Update staff member
    const updatedStaff = {
      ...staff,
      points: newPoints,
      level: newLevel
    };

    await kv.set(`user:${staffId}`, updatedStaff);

    // Update event to mark points as awarded
    const updatedEvent = {
      ...event,
      pointsAwarded: [...pointsAwarded, staffId]
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    // Record adjustment
    const adjustmentId = `${Date.now()}`;
    const adjustment = {
      id: adjustmentId,
      staffId,
      points: event.points,
      reason: `Completed Event: ${event.name}`,
      timestamp: new Date().toISOString(),
      adminId: user.id,
      eventId: eventId
    };

    await kv.set(`adjustment:${adjustmentId}`, adjustment);

    // Send email notification to staff member
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #10B981; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
          .points-box { background-color: white; padding: 25px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10B981; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); text-align: center; }
          .points-value { font-size: 48px; font-weight: bold; color: #10B981; margin: 10px 0; }
          .event-box { background-color: #EFF6FF; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3B82F6; }
          .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #6b7280; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div style="text-align: center; margin-bottom: 10px;">
              <img src="https://img1.wsimg.com/isteam/ip/aead55c7-5dc3-4ad4-8132-6139ccf3e033/nahky.png/:/rs=w:132,h:104,cg:true,m/cr=w:132,h:104/qt=q:95" alt="Nahky Araby Logo" style="max-width: 200px; height: auto;" />
            </div>
            <h2 style="margin: 10px 0 20px 0; font-size: 24px; font-weight: 600; opacity: 1;">Nahky Araby Event Hub</h2>
            <h1>🎉 Event Completed - Points Earned!</h1>
          </div>
          <div class="content">
            <p>Hello ${staff.name},</p>
            
            <p>Congratulations! You have successfully completed an event and earned points!</p>
            
            <div class="points-box">
              <div style="font-size: 16px; color: #6B7280; margin-bottom: 5px;">Points Earned</div>
              <div class="points-value">+${event.points}</div>
              <div style="font-size: 14px; color: #6B7280; margin-top: 10px;">New Total: ${newPoints} points</div>
              ${oldLevel !== newLevel ? `<div style="font-size: 16px; color: #10B981; margin-top: 15px; font-weight: bold;">🎊 Level Up! You are now ${newLevel}!</div>` : ''}
            </div>
            
            <div class="event-box">
              <h3 style="margin-top: 0; color: #3B82F6;">📅 Event Details</h3>
              <p style="margin: 5px 0;"><strong>Event:</strong> ${event.name}</p>
              <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
              <p style="margin: 5px 0;"><strong>Location:</strong> ${event.location}</p>
            </div>
            
            <p>Thank you for your participation and dedication! You can view your updated points and level by logging into Nahky Araby Event Hub.</p>
            
            <p style="margin-top: 30px;">Keep up the excellent work!</p>
          </div>
          <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const emailResult = await sendEmail(
        staff.email,
        `Event Completed: You earned ${event.points} points!`,
        emailHtml
      );
      
      if (emailResult.success) {
        console.log(`✅ Event completion email sent successfully`);
        console.log(`   📧 To: ${staff.name} (${staff.email})`);
        console.log(`   📝 Subject: Event Completed: You earned ${event.points} points!`);
      } else {
        console.log(`⚠️ Event completion email failed`);
        console.log(`   📧 Intended for: ${staff.name} (${staff.email})`);
        console.log(`   ❌ Error: ${emailResult.error}`);
        if (emailResult.isTestingMode) {
          console.log(`   ℹ️ NOTE: In Resend test mode, check delivered@resend.dev for this email`);
        }
      }
    } catch (emailError) {
      console.error('❌ Error sending event completion email:', emailError);
    }

    return c.json({ 
      success: true, 
      staff: updatedStaff,
      event: updatedEvent,
      adjustment,
      leveledUp: oldLevel !== newLevel
    });
  } catch (error) {
    console.error('Error confirming participation:', error);
    return c.json({ error: 'Failed to confirm participation' }, 500);
  }
});

// Confirm all participants for an event at once (admin only)
app.post("/make-server-08658f87/participation/confirm-all", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { eventId } = await c.req.json();

    if (!eventId) {
      return c.json({ error: 'Event ID is required' }, 400);
    }

    // Get event
    const event = await kv.get(`event:${eventId}`);
    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    const confirmedStaff = event.confirmedStaff || [];
    const pointsAwarded = event.pointsAwarded || [];
    
    // Only award points to selected staff who haven't received points yet
    const staffToConfirm = confirmedStaff.filter((staffId: string) => !pointsAwarded.includes(staffId));

    if (staffToConfirm.length === 0) {
      return c.json({ error: 'No staff members awaiting point confirmation' }, 400);
    }

    const updatedStaffList = [];
    const adjustments = [];
    const levelUps = [];

    // Process each staff member who needs points
    for (const staffId of staffToConfirm) {
      const staff = await kv.get(`user:${staffId}`);
      if (!staff) {
        console.warn(`Staff member ${staffId} not found, skipping`);
        continue;
      }

      // Calculate new points and level
      const oldLevel = staff.level;
      const newPoints = staff.points + event.points;
      const newLevel = await calculateLevel(newPoints);

      // Update staff member
      const updatedStaff = {
        ...staff,
        points: newPoints,
        level: newLevel
      };

      await kv.set(`user:${staffId}`, updatedStaff);
      updatedStaffList.push(updatedStaff);

      // Record adjustment
      const adjustmentId = `${Date.now()}-${staffId}`;
      const adjustment = {
        id: adjustmentId,
        staffId,
        points: event.points,
        reason: `Completed Event: ${event.name}`,
        timestamp: new Date().toISOString(),
        adminId: user.id,
        eventId: eventId
      };

      await kv.set(`adjustment:${adjustmentId}`, adjustment);
      adjustments.push(adjustment);

      // Track level ups
      if (oldLevel !== newLevel) {
        levelUps.push({ staffId, name: staff.name, oldLevel, newLevel });
      }
    }

    // Update event to mark points as awarded
    const updatedEvent = {
      ...event,
      pointsAwarded: [...pointsAwarded, ...staffToConfirm]
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    return c.json({ 
      success: true, 
      event: updatedEvent,
      confirmedCount: staffToConfirm.length,
      staffList: updatedStaffList,
      adjustments,
      levelUps
    });
  } catch (error) {
    console.error('Error confirming all participants:', error);
    return c.json({ error: 'Failed to confirm all participants' }, 500);
  }
});

// ==================== INITIALIZATION ENDPOINT ====================

// Initialize database with seed data (for first-time setup)
app.post("/make-server-08658f87/init", async (c) => {
  try {
    console.log('=== Starting database initialization ===');
    
    // Check if already initialized
    const existingUsers = await kv.getByPrefix('user:');
    
    console.log('Existing users:', existingUsers.length);
    
    if (existingUsers.length > 0) {
      console.log('Database already initialized');
      return c.json({ 
        success: true,
        message: 'Database already initialized',
        credentials: {
          admin: { email: 'admin@company.com', password: 'admin123' },
          staff: { email: 'sarah.johnson@company.com', password: 'password123' }
        }
      });
    }

    const supabase = getSupabaseAdmin();
    
    // Create default levels
    console.log('Creating default levels...');
    const defaultLevels = [
      { id: 'level-1', name: 'Level 1', minPoints: 0, order: 0 },
      { id: 'level-2', name: 'Level 2', minPoints: 1000, order: 1 },
    ];
    
    for (const level of defaultLevels) {
      await kv.set(`level:${level.id}`, {
        ...level,
        createdAt: new Date().toISOString()
      });
    }
    console.log('Default levels created');
    
    console.log('Creating admin user...');

    // Create admin user
    const { data: adminAuth, error: adminError } = await supabase.auth.admin.createUser({
      email: 'admin@company.com',
      password: 'admin123',
      user_metadata: { 
        name: 'Admin User',
        role: 'admin'
      },
      email_confirm: true
    });

    if (adminError) {
      console.error('Error creating admin user:', adminError);
    } else if (adminAuth) {
      console.log('Admin user created:', adminAuth.user.id);
      await kv.set(`user:${adminAuth.user.id}`, {
        id: adminAuth.user.id,
        email: 'admin@company.com',
        name: 'Admin User',
        role: 'admin',
        status: 'active',
        createdAt: new Date().toISOString()
      });
      console.log('Admin user saved to KV store');
    }

    // Create sample staff members
    console.log('Creating staff members...');
    const staffData = [
      { email: 'sarah.johnson@company.com', name: 'Sarah Johnson', points: 850 },
      { email: 'mike.chen@company.com', name: 'Mike Chen', points: 1250 },
      { email: 'emma.davis@company.com', name: 'Emma Davis', points: 450 },
      { email: 'hadi.abudayya@gmail.com', name: 'Hadi Abudaya', points: 600 },
    ];

    for (const staff of staffData) {
      // Calculate level based on points
      const staffLevel = await calculateLevel(staff.points);
      
      const { data: staffAuth, error: staffError } = await supabase.auth.admin.createUser({
        email: staff.email,
        password: 'password123',
        user_metadata: { 
          name: staff.name,
          role: 'staff',
          points: staff.points,
          level: staffLevel
        },
        email_confirm: true
      });

      if (staffError) {
        console.error(`Error creating staff ${staff.email}:`, staffError);
      } else if (staffAuth) {
        console.log(`Staff created: ${staff.email} (${staffAuth.user.id})`);
        await kv.set(`user:${staffAuth.user.id}`, {
          id: staffAuth.user.id,
          email: staff.email,
          name: staff.name,
          points: staff.points,
          level: staffLevel,
          role: 'staff',
          status: 'active',
          createdAt: new Date().toISOString()
        });
      }
    }
    console.log('Staff members created');

    // Create sample events using the configured levels
    const level1 = defaultLevels[0].name; // First level (lowest)
    const level2 = defaultLevels[1].name; // Second level
    
    const events = [
      {
        id: `${Date.now()}-1`,
        name: 'Summer Workshop Series',
        date: '2025-11-15',
        time: '09:00',
        duration: '4 hours',
        location: 'Main Campus - Room 101',
        points: 150,
        requiredLevel: level1,
        signedUpStaff: [],
        createdAt: new Date().toISOString()
      },
      {
        id: `${Date.now()}-2`,
        name: 'Advanced Training Session',
        date: '2025-11-20',
        time: '14:00',
        duration: '3 hours',
        location: 'Training Center - Hall A',
        points: 250,
        requiredLevel: level2,
        signedUpStaff: [],
        createdAt: new Date().toISOString()
      },
      {
        id: `${Date.now()}-3`,
        name: 'Community Outreach Event',
        date: '2025-11-22',
        time: '10:00',
        duration: '6 hours',
        location: 'Community Center',
        points: 200,
        requiredLevel: level1,
        signedUpStaff: [],
        createdAt: new Date().toISOString()
      }
    ];

    console.log('Creating sample events...');
    for (const event of events) {
      await kv.set(`event:${event.id}`, event);
    }
    console.log('Sample events created');

    console.log('=== Database initialization complete ===');
    return c.json({ 
      success: true, 
      message: 'Database initialized with seed data',
      credentials: {
        admin: { email: 'admin@company.com', password: 'admin123' },
        staff: { email: 'sarah.johnson@company.com', password: 'password123' }
      }
    });
  } catch (error) {
    console.error('Initialization error:', error);
    return c.json({ error: `Failed to initialize database: ${error.message}` }, 500);
  }
});

// Close event with approval selection (admin only)
app.post("/make-server-08658f87/events/close", async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const { error: authError, user } = await verifyAuth(authHeader);
    
    if (authError || !user) {
      return c.json({ error: authError || 'Unauthorized' }, 401);
    }

    // Check if user is admin
    const userData = await kv.get(`user:${user.id}`);
    if (!userData || userData.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { eventId, approvedStaffIds } = await c.req.json();

    if (!eventId) {
      return c.json({ error: 'Event ID is required' }, 400);
    }

    // Get the event
    const event = await kv.get(`event:${eventId}`);
    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // Get all signed up staff
    const signedUpStaffIds = event.signedUpStaff || [];
    const rejectedStaffIds = signedUpStaffIds.filter(id => !approvedStaffIds.includes(id));

    // Track previous selection state to determine who needs notifications
    const previouslyConfirmedStaff = event.confirmedStaff || [];
    // Check if event has EVER been closed before (not just current status)
    const wasClosedBefore = event.hasBeenClosedBefore || false;

    console.log(`📋 Closing event "${event.name}": ${approvedStaffIds.length} approved, ${rejectedStaffIds.length} rejected`);
    if (wasClosedBefore) {
      console.log(`  ℹ️ Event was previously closed with ${previouslyConfirmedStaff.length} confirmed staff`);
    } else {
      console.log(`  ℹ️ First time closing this event`);
    }

    // Update event - replace confirmedStaff with only the approved staff
    const updatedEvent = {
      ...event,
      confirmedStaff: approvedStaffIds,
      status: 'closed',
      hasBeenClosedBefore: true  // Mark that this event has been closed at least once
    };

    await kv.set(`event:${eventId}`, updatedEvent);

    console.log(`  ✓ Event "${event.name}" closed successfully`);
    console.log(`  ✓ Marked ${approvedStaffIds.length} staff as selected`);

    // Determine which staff members had their selection status changed
    let newlySelected = [];
    let newlyDeselected = [];

    if (wasClosedBefore) {
      // Event was previously closed - only notify staff whose status changed
      newlySelected = approvedStaffIds.filter(id => !previouslyConfirmedStaff.includes(id));
      newlyDeselected = signedUpStaffIds.filter(id => 
        previouslyConfirmedStaff.includes(id) && !approvedStaffIds.includes(id)
      );
      console.log(`  📊 Status changes: ${newlySelected.length} newly selected, ${newlyDeselected.length} newly deselected`);
    } else {
      // Event was not previously closed - notify all staff
      newlySelected = approvedStaffIds;
      newlyDeselected = rejectedStaffIds;
      console.log(`  📊 First time closing: notifying all ${newlySelected.length + newlyDeselected.length} staff`);
    }

    // Send Telegram notifications only to staff whose status changed
    const telegramSettings = await kv.get('telegram:settings');
    console.log(`✈️ Telegram settings for event closure:`, telegramSettings ? { connected: telegramSettings.connected, botName: telegramSettings.botName } : 'NOT CONFIGURED');
    
    if (telegramSettings && telegramSettings.connected) {
      const totalToNotify = newlySelected.length + newlyDeselected.length;
      console.log(`✈️ Telegram is connected, sending closure notifications to ${totalToNotify} staff members with status changes`);
      
      let telegramSentCount = 0;
      
      // Send to newly selected staff
      for (let i = 0; i < newlySelected.length; i++) {
        const staffId = newlySelected[i];
        const staff = await kv.get(`user:${staffId}`);
        
        if (!staff) {
          console.log(`  ⚠️ Staff ${staffId}: Not found, skipping`);
          continue;
        }
        
        // Check if staff member has a Telegram chat ID
        const chatId = staff.telegramChatId || staff.telegramUsername;
        if (!chatId || chatId.trim() === '') {
          console.log(`  ⚠️ ${staff.name}: No Telegram chat ID on file, skipping Telegram`);
          continue;
        }
        
        console.log(`  📤 Sending selection notification to ${staff.name} (${chatId})...`);
        
        const telegramMessage = `Hello ${staff.name},

🎉 *Congratulations!* 🎉

You have been selected to participate in the following event:

📅 *${event.name}*
📍 Location: ${event.location}
📆 Date: ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Time: ${event.time}
⭐ Points: ${event.points} points${event.description ? `

📝 Description: ${event.description}` : ''}${event.notes ? `

💬 Notes: ${event.notes}` : ''}

We look forward to seeing you there! You will receive your points after the event is completed.`;
        
        const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
        
        if (telegramResult.success) {
          console.log(`  ✓ Telegram sent successfully to ${staff.name} (${chatId})`);
          telegramSentCount++;
        } else {
          console.log(`  ✗ Failed to send Telegram to ${staff.name} (${chatId}): ${telegramResult.error}`);
        }
        
        // Rate limiting: Wait 600ms between messages
        if (i < newlySelected.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 600));
        }
      }
      
      // Send to newly deselected staff
      for (let i = 0; i < newlyDeselected.length; i++) {
        const staffId = newlyDeselected[i];
        const staff = await kv.get(`user:${staffId}`);
        
        if (!staff) {
          console.log(`  ⚠️ Staff ${staffId}: Not found, skipping`);
          continue;
        }
        
        // Check if staff member has a Telegram chat ID
        const chatId = staff.telegramChatId || staff.telegramUsername;
        if (!chatId || chatId.trim() === '') {
          console.log(`  ⚠️ ${staff.name}: No Telegram chat ID on file, skipping Telegram`);
          continue;
        }
        
        console.log(`  📤 Sending non-selection notification to ${staff.name} (${chatId})...`);
        
        const telegramMessage = `Hello ${staff.name},

Thank you for signing up for *${event.name}*!

Unfortunately, you were not selected for this event on ${new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.${event.description ? `

📝 Event Description: ${event.description}` : ''}${event.notes ? `

💬 Notes: ${event.notes}` : ''}

Don't worry! There will be many more opportunities to participate in upcoming events. Please keep an eye on the app for new events and continue signing up.

We appreciate your enthusiasm and look forward to having you at future events! 🌟`;
        
        const telegramResult = await sendTelegramMessage(chatId, telegramMessage);
        
        if (telegramResult.success) {
          console.log(`  ✓ Telegram sent successfully to ${staff.name} (${chatId})`);
          telegramSentCount++;
        } else {
          console.log(`  ✗ Failed to send Telegram to ${staff.name} (${chatId}): ${telegramResult.error}`);
        }
        
        // Rate limiting: Wait 600ms between messages
        if (i < newlyDeselected.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 600));
        }
      }
      
      console.log(`✅ Sent ${telegramSentCount} Telegram notifications for event closure (${newlySelected.length} selected, ${newlyDeselected.length} deselected)`);
    } else {
      console.log(`⚠️ Telegram not configured, skipping notifications`);
    }

    return c.json({
      success: true,
      event: updatedEvent
    });
  } catch (error) {
    console.error('Error closing event:', error);
    return c.json({ error: 'Failed to close event' }, 500);
  }
});

Deno.serve(app.fetch);
