import asyncio
from pymodbus.client import ModbusTcpClient
from pymodbus.transaction import ModbusRtuFramer

HOST = "127.0.0.1"
PORT = 8887
SLAVE_ID = 1

def test_framer(framer_class, name):
    print(f"\n--- Testing with {name} ---")
    try:
        if framer_class:
            client = ModbusTcpClient(HOST, port=PORT, framer=framer_class, timeout=3)
        else:
            client = ModbusTcpClient(HOST, port=PORT, timeout=3) # Defaults to ModbusSocketFramer

        if client.connect():
            print("Connected to TCP port.")
            # Try to read holding register 0
            result = client.read_holding_registers(address=0, count=1, slave=SLAVE_ID)
            if result.isError():
                print(f"Modbus Error: {result}")
            else:
                print(f"Success! Registers: {result.registers}")
            client.close()
        else:
            print("Failed to connect to TCP port.")
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    test_framer(ModbusRtuFramer, "ModbusRtuFramer (RTU over TCP)")
    test_framer(None, "ModbusSocketFramer (Standard Modbus TCP)")
