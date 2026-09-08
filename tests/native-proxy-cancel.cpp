#include "server-models.h"
#include <chrono>
#include <iostream>
#include <thread>

int main(int, char ** argv) {
    if (std::string(argv[1]) == "poll") {
        server_response responses;
        responses.add_waiting_task_id(2);
        std::thread other_tasks([&responses]() {
            for (int i = 0; i < 30; ++i) {
                auto result = std::make_unique<server_task_result_control>();
                result->id = 2;
                responses.send(std::move(result));
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        });
        const auto start = std::chrono::steady_clock::now();
        auto result = responses.recv_with_timeout({1}, 1);
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        other_tasks.join();
        std::cout << "{\"poll_deadline_ms\":" << elapsed << "}" << std::endl;
        return !result && elapsed >= 900 && elapsed < 2000 ? 0 : 1;
    }
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
