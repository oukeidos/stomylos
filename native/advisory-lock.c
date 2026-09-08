#include <node_api.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>

/* Whole-file POSIX record lock; release occurs on fd close or process exit.
 * Keep one fd owner: closing another descriptor for this inode releases fcntl locks.
 * Runtime code must never reopen this lock file while it holds the lock. */
static napi_value lock_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, "invalid_lock_fd", "Invalid lock descriptor");
    return NULL;
  }
  struct flock lock;
  memset(&lock, 0, sizeof(lock));
  lock.l_type = F_WRLCK;
  lock.l_whence = SEEK_SET;
  int status;
  do { status = fcntl(fd, F_SETLK, &lock); } while (status == -1 && errno == EINTR);
  if (status == -1) {
    const char *code = (errno == EACCES || errno == EAGAIN) ? "database_already_open" : "lock_failed";
    napi_throw_error(env, code, code);
    return NULL;
  }
  napi_get_undefined(env, &result);
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "lock", NAPI_AUTO_LENGTH, lock_fd, NULL, &fn);
  napi_set_named_property(env, exports, "lock", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
