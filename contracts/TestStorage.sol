// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract TestStorage {
    mapping(address => uint256) public values;
    mapping(address => string) public messages;
    mapping(uint256 => address) public indexToAddress;
    
    uint256 public totalOperations;
    address[] public participants;
    
    event ValueStored(address indexed user, uint256 value);
    event MessageStored(address indexed user, string message);
    event BatchOperation(address indexed user, uint256 count);
    
    function storeValue(uint256 value) public {
        values[msg.sender] = value;
        totalOperations++;
        
        if (values[msg.sender] == value) {
            participants.push(msg.sender);
        }
        
        emit ValueStored(msg.sender, value);
    }
    
    function storeMessage(string memory message) public {
        messages[msg.sender] = message;
        totalOperations++;
        emit MessageStored(msg.sender, message);
    }
    
    function batchStore(uint256[] memory nums, string[] memory msgs) public {
        require(nums.length == msgs.length, "Arrays must have equal length");
        
        for (uint i = 0; i < nums.length; i++) {
            values[msg.sender] = nums[i];
            messages[msg.sender] = msgs[i];
            totalOperations++;
        }
        
        emit BatchOperation(msg.sender, nums.length);
    }
    
    function heavyComputation(uint256 iterations) public returns (uint256) {
        uint256 result = 0;
        for (uint256 i = 0; i < iterations; i++) {
            result += i * i + block.timestamp;
            if (i % 100 == 0) {
                totalOperations++;
            }
        }
        values[msg.sender] = result;
        return result;
    }
    
    function getValue(address user) public view returns (uint256) {
        return values[user];
    }
    
    function getMessage(address user) public view returns (string memory) {
        return messages[user];
    }
    
    function getParticipantCount() public view returns (uint256) {
        return participants.length;
    }
}