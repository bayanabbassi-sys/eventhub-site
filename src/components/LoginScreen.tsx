import { useState, useEffect } from 'react';
import { Mail, Lock, Briefcase, Info } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { PasswordSetup } from './PasswordSetup';
import logoImage from 'figma:asset/a18c9f29652fad36842de1eae7c0067139d8f193.png';

interface LoginScreenProps {
  onLogin: (email: string, password: string) => boolean | Promise<any>;
  onPasswordSetup?: (email: string, tempPassword: string, newPassword: string) => Promise<boolean>;
}

export function LoginScreen({ onLogin, onPasswordSetup }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPasswordSetup, setShowPasswordSetup] = useState(false);
  const [confirmationData, setConfirmationData] = useState<{ email: string; tempPassword: string } | null>(null);
  const [showManualLogin, setShowManualLogin] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    // Simulate authentication delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const result = await onLogin(email, password);
    
    // Check if user needs to set up password
    if (result && typeof result === 'object' && result.needsPasswordSetup) {
      setConfirmationData({
        email: result.email,
        tempPassword: result.tempPassword
      });
      setShowPasswordSetup(true);
    }
    
    setIsLoading(false);
  };

  const handleDemoLogin = (demoEmail: string, demoPassword: string) => {
    setEmail(demoEmail);
    setPassword(demoPassword);
    onLogin(demoEmail, demoPassword);
  };

  const handlePasswordSet = async (newPassword: string): Promise<boolean> => {
    if (!confirmationData || !onPasswordSetup) return false;
    
    const success = await onPasswordSetup(
      confirmationData.email,
      confirmationData.tempPassword,
      newPassword
    );
    
    if (success) {
      // Password setup successful - user is now logged in
      setShowPasswordSetup(false);
      setConfirmationData(null);
    }
    
    return success;
  };

  const handleCancelPasswordSetup = () => {
    setShowPasswordSetup(false);
    setConfirmationData(null);
    setEmail('');
    setPassword('');
  };

  if (showPasswordSetup && confirmationData) {
    return (
      <PasswordSetup
        email={confirmationData.email}
        tempPassword={confirmationData.tempPassword}
        onPasswordSet={handlePasswordSet}
        onCancel={handleCancelPasswordSetup}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#5D2972] to-[#00A5B5] flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto mb-4">
            <img src={logoImage} alt="Nahky Araby Logo" className="w-48 h-auto mx-auto" />
          </div>
          <CardTitle>Nahky Araby Event Hub</CardTitle>
          <CardDescription>
            Sign in to manage events and track your progress
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Manual login form - displayed at the top */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  id="email"
                  type="email"
                  placeholder="your.email@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  required
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10"
                  required
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <p className="text-center text-gray-500">
            New staff members receive login credentials via email
          </p>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-2 text-gray-500">Or try demo accounts</span>
            </div>
          </div>

          {/* Demo accounts section */}
          {!showManualLogin ? (
            <div className="text-center">
              <button
                type="button"
                onClick={() => setShowManualLogin(true)}
                className="text-[#00A5B5] hover:text-[#008a97] underline"
              >
                Show demo accounts
              </button>
            </div>
          ) : (
            <>
              <Alert className="border-[#00A5B5] bg-[#e6f7f9]">
                <Info className="h-4 w-4 text-[#00A5B5]" />
                <AlertDescription className="text-[#333333]">
                  <strong>Demo accounts available:</strong> Explore the app instantly - no signup needed!
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Button
                  variant="default"
                  size="lg"
                  className="w-full bg-gradient-to-r from-[#5D2972] to-[#7a3a94] hover:from-[#4a1f5a] hover:to-[#5D2972]"
                  onClick={() => handleDemoLogin('admin@company.com', 'admin123')}
                >
                  🔑 Demo Admin Account
                </Button>
                <Button
                  variant="outline"
                  className="w-full border-2 border-[#00A5B5] hover:bg-[#e6f7f9] hover:border-[#008a97] text-[#00A5B5] hover:text-[#008a97]"
                  onClick={() => handleDemoLogin('sarah.johnson@company.com', 'password123')}
                >
                  👤 Demo Staff - Sarah
                </Button>
                <Button
                  variant="outline"
                  className="w-full border-2 border-[#00A5B5] hover:bg-[#e6f7f9] hover:border-[#008a97] text-[#00A5B5] hover:text-[#008a97]"
                  onClick={() => handleDemoLogin('mike.chen@company.com', 'password123')}
                >
                  👤 Demo Staff - Mike
                </Button>
                <Button
                  variant="outline"
                  className="w-full border-2 border-[#00A5B5] hover:bg-[#e6f7f9] hover:border-[#008a97] text-[#00A5B5] hover:text-[#008a97]"
                  onClick={() => handleDemoLogin('emma.davis@company.com', 'password123')}
                >
                  👤 Demo Staff - Emma
                </Button>
              </div>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setShowManualLogin(false)}
                  className="text-gray-500 hover:text-gray-700 underline"
                >
                  Hide demo accounts
                </button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}