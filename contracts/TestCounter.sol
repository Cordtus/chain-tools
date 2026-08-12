// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract TestCounter {
    uint256 public count;
    mapping(address => uint256) public userCounts;
    mapping(address => uint256[]) public userHistory;
    
    event CountIncremented(address indexed user, uint256 newCount, uint256 globalCount);
    event CountDecremented(address indexed user, uint256 newCount, uint256 globalCount);
    event CountReset(address indexed user);
    
    function increment() public {
        count++;
        userCounts[msg.sender]++;
        userHistory[msg.sender].push(count);
        emit CountIncremented(msg.sender, userCounts[msg.sender], count);
    }
    
    function decrement() public {
        if (count > 0) {
            count--;
        }
        if (userCounts[msg.sender] > 0) {
            userCounts[msg.sender]--;
        }
        userHistory[msg.sender].push(count);
        emit CountDecremented(msg.sender, userCounts[msg.sender], count);
    }
    
    function incrementBy(uint256 amount) public {
        count += amount;
        userCounts[msg.sender] += amount;
        
        for (uint256 i = 0; i < amount; i++) {
            userHistory[msg.sender].push(count - amount + i + 1);
        }
        
        emit CountIncremented(msg.sender, userCounts[msg.sender], count);
    }
    
    function reset() public {
        userCounts[msg.sender] = 0;
        delete userHistory[msg.sender];
        emit CountReset(msg.sender);
    }
    
    function batchIncrement(uint256 times) public {
        for (uint256 i = 0; i < times; i++) {
            count++;
            userCounts[msg.sender]++;
            userHistory[msg.sender].push(count);
        }
        emit CountIncremented(msg.sender, userCounts[msg.sender], count);
    }
    
    function getUserHistory(address user) public view returns (uint256[] memory) {
        return userHistory[user];
    }
    
    function getUserHistoryLength(address user) public view returns (uint256) {
        return userHistory[user].length;
    }
}