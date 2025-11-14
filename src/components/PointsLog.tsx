import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Button } from './ui/button';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react';
import { Badge } from './ui/badge';
import { StaffMember, PointAdjustment } from '../App';

export interface PointTransaction {
  id: string;
  staffId: string;
  staffName: string;
  points: number; // positive for addition, negative for subtraction
  reason: string;
  timestamp: string;
  adminId: string;
  eventId?: string;
}

interface PointsLogProps {
  pointAdjustments: PointAdjustment[];
  pointTransactions: PointTransaction[];
  staffMembers: StaffMember[];
}

export function PointsLog({ pointAdjustments, pointTransactions, staffMembers }: PointsLogProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Merge old adjustments and new transactions
  // Convert old PointAdjustments to PointTransactions format
  const convertedAdjustments: PointTransaction[] = pointAdjustments.map(adj => {
    const staff = staffMembers.find(s => s.id === adj.staffId);
    return {
      id: adj.id,
      staffId: adj.staffId,
      staffName: staff?.name || 'Unknown Staff',
      points: adj.points,
      reason: adj.reason,
      timestamp: adj.timestamp,
      adminId: adj.adminId,
    };
  });

  // Combine both sources and deduplicate by ID
  const allTransactionsMap = new Map<string, PointTransaction>();
  
  // Add transactions first (newer format, takes precedence)
  pointTransactions.forEach(t => allTransactionsMap.set(t.id, t));
  
  // Add converted adjustments only if ID doesn't exist
  convertedAdjustments.forEach(t => {
    if (!allTransactionsMap.has(t.id)) {
      allTransactionsMap.set(t.id, t);
    }
  });
  
  const allTransactions = Array.from(allTransactionsMap.values());

  // Sort transactions by timestamp (newest first)
  const sortedTransactions = allTransactions.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Pagination
  const totalPages = Math.ceil(sortedTransactions.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentTransactions = sortedTransactions.slice(startIndex, endIndex);

  const formatDateTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const getStaffName = (staffId: string) => {
    const staff = staffMembers.find(s => s.id === staffId);
    return staff?.name || 'Unknown Staff';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-gray-900">Points Log</h2>
        <p className="text-gray-500">View all point transactions and adjustments</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Transaction History</span>
            <Badge variant="secondary">
              {sortedTransactions.length} total transaction{sortedTransactions.length !== 1 ? 's' : ''}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sortedTransactions.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No point transactions yet
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff Member</TableHead>
                      <TableHead>Date & Time</TableHead>
                      <TableHead className="text-center">Points</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentTransactions.map((transaction) => (
                      <TableRow key={transaction.id}>
                        <TableCell>
                          <div>
                            <div className="text-gray-900">{transaction.staffName}</div>
                            <div className="text-sm text-gray-500">
                              {getStaffName(transaction.staffId) !== transaction.staffName 
                                ? `(${getStaffName(transaction.staffId)})`
                                : ''
                              }
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm text-gray-600">
                            {formatDateTime(transaction.timestamp)}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge 
                            variant={transaction.points > 0 ? 'default' : 'destructive'}
                            className={transaction.points > 0 ? 'bg-green-600 hover:bg-green-600' : ''}
                          >
                            {transaction.points > 0 ? (
                              <TrendingUp className="h-3 w-3 mr-1" />
                            ) : (
                              <TrendingDown className="h-3 w-3 mr-1" />
                            )}
                            {transaction.points > 0 ? '+' : ''}{transaction.points}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm text-gray-700 max-w-md">
                            {transaction.reason}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <div className="text-sm text-gray-600">
                    Showing {startIndex + 1} to {Math.min(endIndex, sortedTransactions.length)} of {sortedTransactions.length} transactions
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <div className="text-sm text-gray-600">
                      Page {currentPage} of {totalPages}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}