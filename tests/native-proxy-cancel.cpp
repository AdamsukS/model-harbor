#include "server-models.h"
#include <chrono>
#include <iostream>
#include <thread>

int main(int, char ** argv) {
    const auto start = std::chrono::steady_clock::now();
    const auto stop = [start]() {
        return std::chrono::steady_clock::now() - start > std::chrono::milliseconds(300);
    };
    {
        server_http_proxy proxy("POST", "http", "127.0.0.1", std::stoi(argv[1]),
                                "/test", {}, "{}", {}, stop, 10, 10);
        if (proxy.status == 200) {
            std::string out;
            proxy.next(out);
        }
    }
    std::cout << "destroyed" << std::endl;
    // Keep the process alive: process exit would hide a leaked upstream connection.
    std::this_thread::sleep_for(std::chrono::seconds(3));
}
